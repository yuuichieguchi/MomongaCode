import { MIN_COLUMNS, MIN_ROWS, NO_FULLSCREEN_NOTICE, PASTE_TOO_LARGE_NOTICE } from './constants.ts';
import type { TerminalEvent } from './events.ts';
import { enterSequenceOf, inTableOrder, LEAVE_EVERY_MODE, leaveSequenceOf, QUERY_BATCH } from './modes.ts';
import type { ScreenMode, TerminalModeName } from './modes.ts';
import { advance, fullscreenRefused, modifyOtherKeysSent, modifyOtherKeysWanted, mouseReported, negotiationFrom, NEWLINE_HINT, synchronizedOutputReported } from './negotiation.ts';
import type { NegotiationState, NewlineHint } from './negotiation.ts';
import { createInputParser } from './parser.ts';

export type TerminalSize = { columns: number; rows: number };

export type TerminalInputPort = {
  setRawMode(on: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  off(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
};

export type TerminalOutputPort = {
  writeSync(text: string): void;
  size(): TerminalSize;
  onResize(listener: () => void): () => void;
};

export const EXIT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

export type ProcessSignal = (typeof EXIT_SIGNALS)[number] | 'SIGSTOP';

export type ProcessEvent = (typeof EXIT_SIGNALS)[number] | 'SIGCONT' | 'exit' | 'uncaughtExceptionMonitor';

export type ProcessPort = {
  on(event: ProcessEvent, listener: () => void): void;
  off(event: ProcessEvent, listener: () => void): void;
  kill(signal: ProcessSignal): void;
};

export type ScreenRequest = { type: 'notice'; text: string } | { type: 'redraw' };

export type HandoverTerminal = { screen: ScreenMode; modes: TerminalModeName[] };

export type TerminalState = {
  screen: ScreenMode;
  negotiation: NegotiationState;
  newlineHint: NewlineHint;
  enabled: readonly TerminalModeName[];
  size: TerminalSize;
  tooSmall: boolean;
  synchronizedOutput: boolean;
  backgroundColor: string | undefined;
};

export type TerminalLayerOptions = {
  input: TerminalInputPort;
  output: TerminalOutputPort;
  process: ProcessPort;
  screen: ScreenMode;
  screenSetByUser: boolean;
  mouse: boolean;
  onEvents(events: readonly TerminalEvent[]): void;
};

export type TerminalLayer = {
  start(): void;
  adopt(terminal: HandoverTerminal, negotiation: NegotiationState): void;
  leaveEveryMode(): void;
  restore(): void;
  close(): void;
  release(): void;
  suspend(): void;
  enable(mode: TerminalModeName): void;
  disable(mode: TerminalModeName): void;
  setScreen(screen: ScreenMode): void;
  handoverTerminal(): HandoverTerminal;
  state(): TerminalState;
  subscribe(listener: () => void): () => void;
  subscribeScreen(listener: (request: ScreenRequest) => void): () => void;
};

export const isTooSmall = (size: TerminalSize): boolean => size.columns < MIN_COLUMNS || size.rows < MIN_ROWS;

const isCtrl = (event: TerminalEvent, letter: string): boolean => event.type === 'key' && 'text' in event && event.text === letter && event.ctrl && !event.alt && !event.shift;

export const createTerminalLayer = (options: TerminalLayerOptions): TerminalLayer => {
  const { input, output, process: host } = options;
  const parser = createInputParser();
  const enabled = new Set<TerminalModeName>();
  const listeners = new Set<() => void>();
  const screenListeners = new Set<(request: ScreenRequest) => void>();
  let negotiation = negotiationFrom('unknown');
  let screen = options.screen;
  let size = output.size();
  let raw = false;
  let mouseAnswered = false;
  let fullscreenRefusalApplied = false;
  let stopResizeListening: (() => void) | undefined;
  let hooked = false;

  const snapshotOf = (): TerminalState => ({
    screen,
    negotiation: negotiation.state,
    newlineHint: NEWLINE_HINT[negotiation.state],
    enabled: inTableOrder(enabled),
    size,
    tooSmall: isTooSmall(size),
    synchronizedOutput: synchronizedOutputReported(negotiation),
    backgroundColor: negotiation.backgroundColor,
  });

  let snapshot = snapshotOf();

  const publish = (): void => {
    snapshot = snapshotOf();
    for (const listener of [...listeners]) listener();
  };

  const request = (screenRequest: ScreenRequest): void => {
    for (const listener of [...screenListeners]) listener(screenRequest);
  };

  const setRaw = (on: boolean): void => {
    if (raw === on) return;
    input.setRawMode(on);
    raw = on;
  };

  const enter = (names: readonly TerminalModeName[]): void => {
    const fresh = names.filter((name) => !enabled.has(name));
    if (fresh.length === 0) return;
    output.writeSync(enterSequenceOf(fresh));
    for (const name of fresh) enabled.add(name);
  };

  const leave = (names: readonly TerminalModeName[]): void => {
    const present = names.filter((name) => enabled.has(name));
    if (present.length === 0) return;
    output.writeSync(leaveSequenceOf(present));
    for (const name of present) enabled.delete(name);
  };

  const restore = (): void => {
    leave(inTableOrder(enabled));
    setRaw(false);
    publish();
  };

  const signalHandlers = EXIT_SIGNALS.map((signal) => ({
    signal,
    handler: (): void => {
      close();
      host.kill(signal);
    },
  }));

  const resume = (saved: readonly TerminalModeName[]) => {
    const onContinue = (): void => {
      host.off('SIGCONT', onContinue);
      setRaw(true);
      enter(saved);
      publish();
      request({ type: 'redraw' });
    };
    return onContinue;
  };

  let pendingContinue: (() => void) | undefined;

  const suspend = (): void => {
    const saved = inTableOrder(enabled);
    restore();
    pendingContinue = resume(saved);
    host.on('SIGCONT', pendingContinue);
    host.kill('SIGSTOP');
  };

  const mouseAllowed = (): boolean => screen === 'fullscreen' && options.mouse && mouseAnswered;

  const setScreen = (next: ScreenMode): void => {
    if (next === screen) return;
    screen = next;
    if (next === 'scrollback') leave(['mouse', 'alt-screen']);
    else enter(mouseAllowed() ? ['alt-screen', 'mouse'] : ['alt-screen']);
    publish();
  };

  const applyReplies = (): void => {
    mouseAnswered ||= mouseReported(negotiation);
    if (mouseAllowed()) enter(['mouse']);
    if (screen === 'fullscreen' && !options.screenSetByUser && !fullscreenRefusalApplied && fullscreenRefused(negotiation)) {
      fullscreenRefusalApplied = true;
      setScreen('scrollback');
      request({ type: 'notice', text: NO_FULLSCREEN_NOTICE });
    }
  };

  const absorb = (event: TerminalEvent): void => {
    const before = negotiation;
    negotiation = advance(negotiation, event);
    if (negotiation === before) return;
    if (modifyOtherKeysWanted(before, negotiation)) {
      enter(['modify-other-keys']);
      negotiation = modifyOtherKeysSent(negotiation);
    }
    applyReplies();
    publish();
  };

  const onData = (chunk: Uint8Array): void => {
    const delivered: TerminalEvent[] = [];
    for (const event of parser.push(chunk)) {
      absorb(event);
      if (isTooSmall(size) && !isCtrl(event, 'c')) continue;
      if (event.type === 'paste' && event.overflow) request({ type: 'notice', text: PASTE_TOO_LARGE_NOTICE });
      else if (isCtrl(event, 'z')) suspend();
      else delivered.push(event);
    }
    if (delivered.length > 0) options.onEvents(delivered);
  };

  const onResize = (): void => {
    size = output.size();
    publish();
  };

  const hook = (): void => {
    if (hooked) return;
    hooked = true;
    host.on('exit', restore);
    host.on('uncaughtExceptionMonitor', restore);
    for (const { signal, handler } of signalHandlers) host.on(signal, handler);
    stopResizeListening = output.onResize(onResize);
    input.on('data', onData);
    input.resume();
  };

  const unhook = (): void => {
    if (!hooked) return;
    hooked = false;
    host.off('exit', restore);
    host.off('uncaughtExceptionMonitor', restore);
    for (const { signal, handler } of signalHandlers) host.off(signal, handler);
    if (pendingContinue !== undefined) host.off('SIGCONT', pendingContinue);
    pendingContinue = undefined;
    stopResizeListening?.();
    stopResizeListening = undefined;
    input.off('data', onData);
    input.pause();
  };

  function close(): void {
    restore();
    unhook();
  }

  const start = (): void => {
    hook();
    setRaw(true);
    const first: TerminalModeName[] = screen === 'fullscreen' ? ['alt-screen', 'bracketed-paste'] : ['bracketed-paste'];
    output.writeSync(`${enterSequenceOf(first)}${QUERY_BATCH}`);
    for (const name of [...first, 'kitty-keys'] as const) enabled.add(name);
    publish();
  };

  const adopt = (terminal: HandoverTerminal, state: NegotiationState): void => {
    hook();
    setRaw(true);
    screen = terminal.screen;
    for (const name of terminal.modes) enabled.add(name);
    mouseAnswered = enabled.has('mouse');
    negotiation = negotiationFrom(state);
    publish();
  };

  return {
    start,
    adopt,
    leaveEveryMode: () => output.writeSync(LEAVE_EVERY_MODE),
    restore,
    close,
    release: unhook,
    suspend,
    enable: (mode) => {
      enter([mode]);
      publish();
    },
    disable: (mode) => {
      leave([mode]);
      publish();
    },
    setScreen,
    handoverTerminal: () => ({ screen, modes: inTableOrder(enabled) }),
    state: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeScreen: (listener) => {
      screenListeners.add(listener);
      return () => {
        screenListeners.delete(listener);
      };
    },
  };
};
