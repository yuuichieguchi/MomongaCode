import type { PublicRunEvent } from '@momonga/protocol';
import type { ScreenTerminal } from '../../src/tui/screen/input.ts';
import { createTranscriptStore } from '../../src/tui/screen/store.ts';
import type { TranscriptState, TranscriptStore } from '../../src/tui/screen/store.ts';
import type { TerminalEvent } from '../../src/tui/terminal/events.ts';
import type { ScreenRequest, TerminalState } from '../../src/tui/terminal/layer.ts';
import type { ScreenMode } from '../../src/tui/terminal/modes.ts';
import { NEWLINE_HINT } from '../../src/tui/terminal/negotiation.ts';
import type { NegotiationState } from '../../src/tui/terminal/negotiation.ts';
import { foldChildEvent, foldEvent } from '../../src/tui/transcript.ts';
import type { Entry } from '../../src/tui/transcript.ts';
import type { Key } from 'ink';
import { DEFAULT_KEY_TABLE } from '../../src/tui/keys/table.ts';
import { NO_A11Y } from '../../src/tui/screen/a11y.ts';
import { rowRenderersOf } from '../../src/tui/screen/row-cache.ts';
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
  const modifiers = { ctrl: key.ctrl === true, alt: key.meta === true, shift: key.shift === true };
  const named = INK_NAMES.find(([flag]) => key[flag] === true);
  return named === undefined ? { type: 'key', text: input, ...modifiers } : { type: 'key', name: named[1], ...modifiers };
};

export const envelope = { id: 1, runId: 'r', sessionId: 's', seq: 1, step: 1, createdAt: 1 } as const;

export const eventOf = (event: Record<string, unknown>): PublicRunEvent => ({ ...envelope, ...event }) as PublicRunEvent;

export type Folded = TranscriptState & { entries: Entry[] };

export const plainOf = (store: TranscriptStore): Folded => ({ ...store.state(), entries: Array.from({ length: store.count() }, (_, index) => store.at(index).entry).filter((entry) => entry.kind !== 'retired') });

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
  resize(columns: number, rows: number): void;
  request(request: ScreenRequest): void;
  shrink(tooSmall: boolean): void;
  negotiate(negotiation: NegotiationState): void;
  screens: ScreenMode[];
  titles: string[];
  bells: string[];
};

export const fakeScreenTerminal = (given: { screen?: ScreenMode; columns?: number; rows?: number } = {}): FakeScreenTerminal => {
  const listeners = new Set<() => void>();
  const screenListeners = new Set<(request: ScreenRequest) => void>();
  const claims: ((event: TerminalEvent) => boolean)[] = [];
  const observers = new Set<(event: TerminalEvent) => void>();
  const screens: ScreenMode[] = [];
  const titles: string[] = [];
  const bells: string[] = [];
  let state: TerminalState = {
    screen: given.screen ?? 'fullscreen',
    negotiation: 'unknown',
    newlineHint: 'ctrl+j',
    enabled: [],
    size: { columns: given.columns ?? 160, rows: given.rows ?? 100 },
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
      claim: (handler) => {
        claims.unshift(handler);
        return () => {
          claims.splice(claims.indexOf(handler), 1);
        };
      },
    },
    emit: (event) => {
      for (const observer of [...observers]) observer(event);
      return claims.some((claim) => claim(event));
    },
    resize: (columns, rows) => publish({ ...state, size: { columns, rows } }),
    shrink: (tooSmall) => publish({ ...state, tooSmall }),
    negotiate: (negotiation) => publish({ ...state, negotiation, newlineHint: NEWLINE_HINT[negotiation] }),
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
