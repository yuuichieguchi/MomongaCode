import type { PublicRunEvent } from '@momonga/protocol';
import type { ScreenTerminal } from '../../src/tui/screen/input.ts';
import { createTranscriptStore } from '../../src/tui/screen/store.ts';
import type { TranscriptState, TranscriptStore } from '../../src/tui/screen/store.ts';
import type { TerminalEvent } from '../../src/tui/terminal/events.ts';
import type { ScreenRequest, TerminalState } from '../../src/tui/terminal/layer.ts';
import type { ScreenMode } from '../../src/tui/terminal/modes.ts';
import { foldChildEvent, foldEvent } from '../../src/tui/transcript.ts';
import type { Entry } from '../../src/tui/transcript.ts';

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
  screens: ScreenMode[];
};

export const fakeScreenTerminal = (given: { screen?: ScreenMode; columns?: number; rows?: number } = {}): FakeScreenTerminal => {
  const listeners = new Set<() => void>();
  const screenListeners = new Set<(request: ScreenRequest) => void>();
  const claims: ((event: TerminalEvent) => boolean)[] = [];
  const screens: ScreenMode[] = [];
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
      claim: (handler) => {
        claims.unshift(handler);
        return () => {
          claims.splice(claims.indexOf(handler), 1);
        };
      },
    },
    emit: (event) => claims.some((claim) => claim(event)),
    resize: (columns, rows) => publish({ ...state, size: { columns, rows } }),
    shrink: (tooSmall) => publish({ ...state, tooSmall }),
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
