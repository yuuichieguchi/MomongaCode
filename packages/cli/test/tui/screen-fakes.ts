import type { PublicRunEvent } from '@momonga/protocol';
import { createClaimTable } from '../../src/tui/screen/input.ts';
import type { ScreenTerminal } from '../../src/tui/screen/input.ts';
import { createTranscriptStore } from '../../src/tui/screen/store.ts';
import type { TranscriptState, TranscriptStore } from '../../src/tui/screen/store.ts';
import type { TerminalEvent } from '../../src/tui/terminal/events.ts';
import { createTerminalLayer } from '../../src/tui/terminal/layer.ts';
import type { ScreenRequest, TerminalState } from '../../src/tui/terminal/layer.ts';
import type { ScreenTimers } from '../../src/tui/screen/timers.ts';
import { EventEmitter } from 'node:events';
import type { ScreenMode } from '../../src/tui/terminal/modes.ts';
import type { NegotiationState } from '../../src/tui/terminal/negotiation.ts';
import { foldChildEvent, foldEvent } from '../../src/tui/transcript.ts';
import type { Entry } from '../../src/tui/transcript.ts';
import type { Key } from 'ink';
import { DEFAULT_KEY_TABLE } from '../../src/tui/keys/table.ts';
import { NO_A11Y } from '../../src/tui/screen/a11y.ts';
import { rowRenderersOf } from '../../src/tui/screen/row-cache.ts';
import type { ParseSchedule } from '../../src/tui/screen/row-cache.ts';
import type { RowFacts } from '../../src/tui/screen/tool-view.ts';
import type { KeyEvent, KeyName } from '../../src/tui/terminal/events.ts';

export const ROW_FACTS: RowFacts = { keys: DEFAULT_KEY_TABLE, a11y: NO_A11Y };

export const ROW_RENDERERS = rowRenderersOf(ROW_FACTS);

const INK_NAMES: readonly (readonly [keyof Key, KeyName])[] = [
  ['upArrow', 'up'],
  ['downArrow', 'down'],
  ['leftArrow', 'left'],
  ['rightArrow', 'right'],
  ['pageUp', 'pageup'],
  ['pageDown', 'pagedown'],
  ['home', 'home'],
  ['end', 'end'],
  ['return', 'enter'],
  ['escape', 'escape'],
  ['tab', 'tab'],
  ['backspace', 'backspace'],
  ['delete', 'delete'],
];

export const keyEventOf = (input: string, key: Partial<Key>): KeyEvent => {
  const modifiers = { ctrl: key.ctrl === true, alt: key.meta === true, shift: key.shift === true, super: false, hyper: false, meta: false };
  const named = INK_NAMES.find(([flag]) => key[flag] === true);
  return named === undefined ? { type: 'key', text: input, ...modifiers } : { type: 'key', name: named[1], ...modifiers };
};

export const envelope = { id: 1, runId: 'r', sessionId: 's', seq: 1, step: 1, createdAt: 1 } as const;

export const eventOf = (event: Record<string, unknown>): PublicRunEvent => ({ ...envelope, ...event }) as PublicRunEvent;

export type Folded = Omit<TranscriptState, 'callInputs'> & { entries: Entry[] };

export const plainOf = (store: TranscriptStore): Folded => {
  const { callInputs: _callInputs, ...state } = store.state();
  return { ...state, entries: Array.from({ length: store.count() }, (_, index) => store.at(index).entry).filter((entry) => entry.kind !== 'retired') };
};

export const storeOf = (events: readonly Record<string, unknown>[], store: TranscriptStore = createTranscriptStore()): TranscriptStore => {
  for (const event of events) foldEvent(store, eventOf(event));
  return store;
};

export const fold = (events: readonly Record<string, unknown>[]): Folded => plainOf(storeOf(events));

export const foldChild = (events: readonly PublicRunEvent[], agent: string, store: TranscriptStore = createTranscriptStore()): TranscriptStore => {
  for (const event of events) foldChildEvent(store, event, agent);
  return store;
};

export type FakeScreenTerminal = ScreenTerminal & {
  emit(event: TerminalEvent): boolean;
  push(events: readonly TerminalEvent[]): void;
  arrived(): void;
  arrivalWatchers(): number;
  framed(): void;
  resize(columns: number, rows: number): void;
  request(request: ScreenRequest): void;
  shrink(tooSmall: boolean): void;
  negotiate(negotiation: NegotiationState): void;
  screens: ScreenMode[];
  titles: string[];
  bells: string[];
};

export type FakeScreenSize = { readonly screen?: ScreenMode; readonly columns: number; readonly rows: number };

export const WIDE_TEST_SCREEN: FakeScreenSize = { columns: 160, rows: 100 };

export const fakeScreenTerminal = (given: FakeScreenSize): FakeScreenTerminal => {
  const listeners = new Set<() => void>();
  const screenListeners = new Set<(request: ScreenRequest) => void>();
  const claims = createClaimTable();
  const observers = new Set<(event: TerminalEvent) => void>();
  const frameListeners = new Set<() => void>();
  const arrivalListeners = new Set<() => void>();
  const screens: ScreenMode[] = [];
  const titles: string[] = [];
  const bells: string[] = [];
  let state: TerminalState = {
    screen: given.screen ?? 'fullscreen',
    negotiation: 'unknown',
    enabled: [],
    size: { columns: given.columns, rows: given.rows },
    tooSmall: false,
    synchronizedOutput: false,
    backgroundColor: undefined,
  };
  const publish = (next: TerminalState): void => {
    state = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    screens,
    titles,
    bells,
    setTitle: (title) => {
      titles.push(title);
    },
    bell: () => {
      bells.push(titles.at(-1) ?? '');
    },
    enable: (mode) => {
      if (!state.enabled.includes(mode)) publish({ ...state, enabled: [...state.enabled, mode] });
    },
    disable: (mode) => {
      if (state.enabled.includes(mode)) publish({ ...state, enabled: state.enabled.filter((name) => name !== mode) });
    },
    state: () => state,
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
    setScreen: (screen) => {
      screens.push(screen);
      publish({ ...state, screen });
    },
    input: {
      observe: (observer) => {
        observers.add(observer);
        return () => {
          observers.delete(observer);
        };
      },
      claim: claims.claim,
      observeArrivals: (listener) => {
        arrivalListeners.add(listener);
        return () => {
          arrivalListeners.delete(listener);
        };
      },
      observeFrames: (listener) => {
        frameListeners.add(listener);
        return () => {
          frameListeners.delete(listener);
        };
      },
    },
    framed: () => {
      for (const listener of [...frameListeners]) listener();
    },
    arrived: () => {
      for (const listener of [...arrivalListeners]) listener();
    },
    arrivalWatchers: () => arrivalListeners.size,
    emit: (event) => {
      for (const listener of [...arrivalListeners]) listener();
      for (const observer of [...observers]) observer(event);
      return claims.offer(event);
    },
    push: (events) => {
      for (const event of events) for (const observer of [...observers]) observer(event);
      for (const event of events) claims.offer(event);
    },
    resize: (columns, rows) => publish({ ...state, size: { columns, rows } }),
    shrink: (tooSmall) => publish({ ...state, tooSmall }),
    negotiate: (negotiation) => publish({ ...state, negotiation }),
    request: (request) => {
      for (const listener of [...screenListeners]) listener(request);
    },
  };
};

export const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

const ALPHABET = ['a', 'b', 'c', ' ', ' ', '\n', '漢', '字', 'é', '👍', 'x', 'y', 'z', '-', 'é'];

export const randomText = (random: () => number, length: number): string => Array.from({ length }, () => ALPHABET[Math.floor(random() * ALPHABET.length)]).join('');

export type ManualSchedule = { schedule: ParseSchedule; waiting(): number; turn(): void; drain(): number; rowsChanged(): number };

export const manualSchedule = (): ManualSchedule => {
  const deferred: (() => void)[] = [];
  let changed = 0;
  const turn = (): void => {
    const next = deferred.shift();
    if (next !== undefined) next();
  };
  return {
    schedule: { defer: (run) => void deferred.push(run), onRows: () => void (changed += 1) },
    waiting: () => deferred.length,
    turn,
    drain: () => {
      let turns = 0;
      for (; deferred.length > 0; turns += 1) turn();
      return turns;
    },
    rowsChanged: () => changed,
  };
};

export const ROW_SCHEDULE = manualSchedule().schedule;

export type ArrivingTerminal = Pick<FakeScreenTerminal, 'push' | 'arrived'>;

export const throughTheLayer = (terminal: ArrivingTerminal, timers: ScreenTimers): ((text: string) => void) => {
  const stdin = new EventEmitter();
  const layer = createTerminalLayer({
    timers,
    input: { setRawMode: () => undefined, resume: () => undefined, pause: () => undefined, on: (event, listener) => stdin.on(event, listener), off: (event, listener) => stdin.off(event, listener) },
    output: { writeSync: () => undefined, size: () => ({ columns: 160, rows: 100 }), onResize: () => () => undefined },
    process: { on: () => undefined, off: () => undefined, kill: () => undefined, deliverable: () => true },
    screen: 'fullscreen',
    screenSetByUser: false,
    mouse: false,
    onFailure: (error) => {
      throw error;
    },
    onEvents: (events) => terminal.push(events),
    onArrival: () => terminal.arrived(),
  });
  layer.start();
  return (text) => void stdin.emit('data', Buffer.from(text, 'utf8'));
};
