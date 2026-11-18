import type { ScreenTimers } from '../screen/timers.ts';
import { KEY_SETTLE_MS, MIN_COLUMNS, NEGOTIATION_DRAIN_MS, MIN_ROWS, NO_FULLSCREEN_NOTICE, PASTE_TOO_LARGE_NOTICE } from './constants.ts';
import type { TerminalEvent } from './events.ts';
import { BACKGROUND_QUERY, DEVICE_ATTRIBUTES_QUERY, enterSequenceOf, inTableOrder, LEAVE_EVERY_MODE, leaveSequenceOf, QUERY_BATCH } from './modes.ts';
import type { ScreenMode, TerminalModeName } from './modes.ts';
import { advance, fullscreenRefused, modifyOtherKeysSent, modifyOtherKeysWanted, mouseReported, negotiationFrom, synchronizedOutputReported } from './negotiation.ts';
import type { NegotiationState } from './negotiation.ts';
import { createInputParser } from './parser.ts';
import { BEL, titleSequence } from './title.ts';

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

export type DeliverableSignal = ProcessSignal | 'SIGCONT';

export type ProcessPort = {
  on(event: ProcessEvent, listener: () => void): void;
  off(event: ProcessEvent, listener: () => void): void;
  kill(signal: ProcessSignal): void;
  deliverable(signal: DeliverableSignal): boolean;
};

export type InkSuspension = { resume(): Promise<void> };

export type InkTerminal = { suspendTerminal(): Promise<InkSuspension> };

export type ScreenRequest = { type: 'notice'; text: string } | { type: 'redraw' };

export type HandoverTerminal = { screen: ScreenMode; modes: TerminalModeName[] };

export type TerminalState = {
  screen: ScreenMode;
  negotiation: NegotiationState;
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
  timers: ScreenTimers;
  screen: ScreenMode;
  screenSetByUser: boolean;
  mouse: boolean;
  onEvents(events: readonly TerminalEvent[]): void;
  onFailure(error: unknown): void;
};

export type TerminalLayer = {
  start(): void;
  adopt(terminal: HandoverTerminal, negotiation: NegotiationState): void;
  leaveEveryMode(): void;
  restore(): void;
  close(): Promise<void>;
  release(): void;
  suspend(): void;
  leaveForProgram(): Promise<() => Promise<void>>;
  attachInk(ink: InkTerminal): () => void;
  enable(mode: TerminalModeName): void;
  disable(mode: TerminalModeName): void;
  setScreen(screen: ScreenMode): void;
  setTitle(title: string): void;
  bell(): void;
  handoverTerminal(): HandoverTerminal;
  state(): TerminalState;
  subscribe(listener: () => void): () => void;
  subscribeScreen(listener: (request: ScreenRequest) => void): () => void;
};

export const isTooSmall = (size: TerminalSize): boolean => size.columns < MIN_COLUMNS || size.rows < MIN_ROWS;

const isCtrl = (event: TerminalEvent, letter: string): boolean => event.type === 'key' && 'text' in event && event.text === letter && event.ctrl && !event.alt && !event.shift && !event.super && !event.hyper && !event.meta;

export const createTerminalLayer = (options: TerminalLayerOptions): TerminalLayer => {
  const { input, output, process: host, timers } = options;
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
  let title: string | undefined;
  let repliesOwed = 0;
  let leavesWaiting: Array<() => void> = [];
  let drainBound: unknown;

  const leaveNow = (): void => {
    if (drainBound !== undefined) timers.clearTimeout(drainBound);
    drainBound = undefined;
    const waiting = leavesWaiting;
    leavesWaiting = [];
    for (const leaveAction of waiting) leaveAction();
  };

  const whenRepliesRead = (leaveAction: () => void): void => {
    if (repliesOwed === 0) {
      leaveAction();
      return;
    }
    leavesWaiting.push(leaveAction);
    drainBound ??= timers.setTimeout(() => {
      drainBound = undefined;
      repliesOwed = 0;
      leaveNow();
    }, NEGOTIATION_DRAIN_MS);
  };


  const snapshotOf = (): TerminalState => ({
    screen,
    negotiation: negotiation.state,
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

  let ink: InkTerminal | undefined;

  const holdInk = (): Promise<InkSuspension> | undefined => ink?.suspendTerminal();

  const releaseInk = async (held: Promise<InkSuspension> | undefined): Promise<void> => {
    if (held !== undefined) await (await held).resume();
  };

  const signalHandlers = EXIT_SIGNALS.filter((signal) => host.deliverable(signal)).map((signal) => ({
    signal,
    handler: (): void => {
      whenRepliesRead(() => {
        closeNow();
        host.kill(signal);
      });
    },
  }));

  const reenter = (saved: readonly TerminalModeName[]): void => {
    setRaw(true);
    enter(saved);
    if (title !== undefined && enabled.has('title')) output.writeSync(titleSequence(title));
    publish();
    request({ type: 'redraw' });
  };

  const resume = (saved: readonly TerminalModeName[], held: Promise<InkSuspension> | undefined) => {
    const onContinue = (): void => {
      host.off('SIGCONT', onContinue);
      reenter(saved);
      releaseInk(held).catch(options.onFailure);
    };
    return onContinue;
  };

  let pendingContinue: (() => void) | undefined;

  const canStop = (): boolean => host.deliverable('SIGSTOP') && host.deliverable('SIGCONT');

  let suspending = false;

  const suspend = (): void => {
    if (!canStop() || suspending) return;
    suspending = true;
    whenRepliesRead(() => {
      suspending = false;
      stopNow();
    });
  };

  const stopNow = (): void => {
    const held = holdInk();
    const saved = inTableOrder(enabled);
    restore();
    pendingContinue = resume(saved, held);
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
    if (event.type === 'report' && event.kind === 'device-attributes' && repliesOwed > 0) {
      repliesOwed -= 1;
    }
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

  const deliver = (events: readonly TerminalEvent[]): void => {
    const delivered: TerminalEvent[] = [];
    for (const event of events) {
      absorb(event);
      if (repliesOwed === 0 && leavesWaiting.length > 0) leaveNow();
      if (event.type === 'focus' && event.direction === 'in' && enabled.has('focus')) {
        output.writeSync(`${BACKGROUND_QUERY}${DEVICE_ATTRIBUTES_QUERY}`);
        repliesOwed += 1;
      }
      if (isTooSmall(size) && !isCtrl(event, 'c')) continue;
      if (event.type === 'paste' && event.overflow) request({ type: 'notice', text: PASTE_TOO_LARGE_NOTICE });
      else if (isCtrl(event, 'z')) suspend();
      else delivered.push(event);
    }
    if (delivered.length > 0) options.onEvents(delivered);
  };

  let keySettle: { timer: unknown } | undefined;

  const stopKeySettle = (): void => {
    if (keySettle === undefined) return;
    timers.clearTimeout(keySettle.timer);
    keySettle = undefined;
  };

  const endKeySettle = (): void => {
    keySettle = undefined;
    deliver(parser.settle());
  };

  const onData = (chunk: Uint8Array): void => {
    stopKeySettle();
    const events = parser.push(chunk);
    if (parser.holdsOpen()) keySettle = { timer: timers.setTimeout(endKeySettle, KEY_SETTLE_MS) };
    deliver(events);
  };

  const onResize = (): void => {
    size = output.size();
    publish();
  };

  const leaveForProgram = (): Promise<() => Promise<void>> => new Promise((resolve) => whenRepliesRead(() => resolve(lendNow())));

  const lendNow = (): (() => Promise<void>) => {
    const held = holdInk();
    const saved = inTableOrder(enabled);
    restore();
    stopKeySettle();
    input.off('data', onData);
    input.pause();
    return async () => {
      if (hooked) {
        input.on('data', onData);
        input.resume();
        reenter(saved);
      }
      await releaseInk(held);
    };
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
    stopKeySettle();
    input.off('data', onData);
    input.pause();
  };

  function closeNow(): void {
    restore();
    unhook();
  }

  function close(): Promise<void> {
    return new Promise((resolve) => {
      whenRepliesRead(() => {
        closeNow();
        resolve();
      });
    });
  }

  const start = (): void => {
    hook();
    setRaw(true);
    const first: TerminalModeName[] = screen === 'fullscreen' ? ['alt-screen', 'bracketed-paste'] : ['bracketed-paste'];
    output.writeSync(`${enterSequenceOf(first)}${QUERY_BATCH}`);
    repliesOwed += 1;
    for (const name of [...first, 'kitty-keys'] as const) enabled.add(name);
    publish();
  };

  let releasedInk: Promise<InkSuspension> | undefined;

  const release = (): void => {
    releasedInk = holdInk();
    unhook();
  };

  const adopt = (terminal: HandoverTerminal, state: NegotiationState): void => {
    const held = releasedInk;
    releasedInk = undefined;
    hook();
    setRaw(true);
    screen = terminal.screen;
    for (const name of terminal.modes) enabled.add(name);
    mouseAnswered = enabled.has('mouse');
    negotiation = negotiationFrom(state);
    publish();
    releaseInk(held).catch(options.onFailure);
  };

  return {
    start,
    adopt,
    leaveEveryMode: () => output.writeSync(LEAVE_EVERY_MODE),
    restore,
    close,
    release,
    suspend,
    leaveForProgram,
    attachInk: (next) => {
      ink = next;
      return () => {
        if (ink === next) ink = undefined;
      };
    },
    enable: (mode) => {
      enter([mode]);
      publish();
    },
    disable: (mode) => {
      leave([mode]);
      publish();
    },
    setScreen,
    setTitle: (next) => {
      title = next;
      enter(['title']);
      output.writeSync(titleSequence(next));
      publish();
    },
    bell: () => output.writeSync(BEL),
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
