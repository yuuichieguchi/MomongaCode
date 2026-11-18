import { callInputTracker } from '@momonga/protocol';
import type { RunStatus } from '@momonga/protocol';
import { jsonValueOrText } from '@momonga/foundation';
import type { AttemptFailed } from '../../retry-wait.ts';
import type { Entry, PendingApproval, PendingElicitation, RunPhase, RunningTool, Subagent, Usage } from '../transcript.ts';

export type StoreEntry = { readonly id: number; readonly version: number; readonly entry: Entry };

export type TranscriptState = {
  callInputs: ReturnType<typeof callInputTracker>;
  runId: string | undefined;
  runStatus: RunStatus | undefined;
  phase: RunPhase | undefined;
  runningTools: readonly RunningTool[];
  openThought: string | undefined;
  newestThought: string | undefined;
  newestExpandableTool: string | undefined;
  thoughtWindow: number;
  answeringTarget: string | undefined;
  shownModels: ReadonlyMap<string, string>;
  lastFailure: AttemptFailed | undefined;
  approval: PendingApproval | undefined;
  queuedApprovals: readonly PendingApproval[];
  elicitation: PendingElicitation | undefined;
  queuedElicitations: readonly PendingElicitation[];
  usage: Usage;
  endedRunsTokens: number;
  contextTokens: number;
  subagents: readonly Subagent[];
};

export const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export const MIN_THOUGHT_WINDOW = 1;

export const initialState: Omit<TranscriptState, 'callInputs'> = {
  runId: undefined,
  runStatus: undefined,
  phase: undefined,
  runningTools: [],
  openThought: undefined,
  newestThought: undefined,
  newestExpandableTool: undefined,
  thoughtWindow: MIN_THOUGHT_WINDOW,
  answeringTarget: undefined,
  shownModels: new Map(),
  lastFailure: undefined,
  approval: undefined,
  queuedApprovals: [],
  elicitation: undefined,
  queuedElicitations: [],
  usage: EMPTY_USAGE,
  endedRunsTokens: 0,
  contextTokens: 0,
  subagents: [],
};

export const freshState = (): TranscriptState => ({ ...initialState, callInputs: callInputTracker(jsonValueOrText) });

export type StoreListener = (entryId: number | undefined, version: number) => void;

export type TranscriptStore = {
  count(): number;
  at(index: number): StoreEntry;
  indexOfId(id: number): number | undefined;
  byKey(key: string): StoreEntry | undefined;
  append(entry: Entry, key?: string): StoreEntry;
  change(key: string, change: (entry: Entry) => Entry): void;
  changeId(id: number, change: (entry: Entry) => Entry): void;
  name(key: string, target: string): void;
  forget(key: string): void;
  open(): string | undefined;
  setOpen(key: string | undefined): void;
  state(): TranscriptState;
  update(patch: Partial<TranscriptState>): void;
  settledAt(index: number): boolean;
  version(): number;
  epoch(): number;
  subscribe(listener: StoreListener): () => void;
  reset(): void;
  hold(): void;
  release(): void;
  shown(): TranscriptStore;
};

type Held = { entries: readonly StoreEntry[]; positions: ReadonlyMap<string, number>; firstId: number; state: TranscriptState; openKey: string | undefined; version: number; epoch: number };

const settled = (entry: Entry): boolean => {
  switch (entry.kind) {
    case 'assistant':
      return !entry.open;
    case 'tool':
      return entry.status === 'completed' || entry.status === 'failed' || entry.status === 'unknown';
    case 'thought':
      return entry.endedAt !== undefined;
    case 'plan':
      return false;
    default:
      return true;
  }
};

export const isSettled = settled;

export const createTranscriptStore = (): TranscriptStore => {
  let entries: StoreEntry[] = [];
  let positions = new Map<string, number>();
  let firstId = 0;
  let nextId = 0;
  let state = freshState();
  let storeVersion = 0;
  let epoch = 0;
  let openKey: string | undefined;
  let held: Held | undefined;
  const listeners = new Set<StoreListener>();

  const tell = (entryId: number | undefined, version: number): void => {
    storeVersion += 1;
    for (const listener of [...listeners]) listener(entryId, version);
  };

  const at = (index: number): StoreEntry => {
    const found = entries[index];
    if (found === undefined) throw new Error(`the transcript has no entry at ${index}`);
    return found;
  };

  const settledAt = (index: number): boolean => {
    const { entry } = at(index);
    return entry.kind === 'banner' ? index < entries.length - 1 : settled(entry);
  };

  const changeAt = (position: number, change: (entry: Entry) => Entry): void => {
    const before = at(position);
    const entry = change(before.entry);
    if (entry === before.entry) return;
    const stored: StoreEntry = { id: before.id, version: before.version + 1, entry };
    entries[position] = stored;
    tell(stored.id, stored.version);
  };

  const live: TranscriptStore = {
    count: () => entries.length,
    at,
    indexOfId: (id) => (id >= firstId && id < firstId + entries.length ? id - firstId : undefined),
    byKey: (key) => {
      const position = positions.get(key);
      return position === undefined ? undefined : at(position);
    },
    append: (entry, key) => {
      const stored: StoreEntry = { id: nextId, version: 0, entry };
      nextId += 1;
      if (key !== undefined) positions.set(key, entries.length);
      entries.push(stored);
      tell(stored.id, stored.version);
      return stored;
    },
    change: (key, change) => {
      const position = positions.get(key);
      if (position !== undefined) changeAt(position, change);
    },
    changeId: (id, change) => {
      if (id >= firstId && id < firstId + entries.length) changeAt(id - firstId, change);
    },
    name: (key, target) => {
      const position = positions.get(target);
      if (position !== undefined) positions.set(key, position);
    },
    forget: (key) => {
      positions.delete(key);
    },
    open: () => openKey,
    setOpen: (key) => {
      openKey = key;
    },
    state: () => state,
    update: (patch) => {
      state = { ...state, ...patch };
      tell(undefined, storeVersion + 1);
    },
    settledAt: (index) => settledAt(index),
    version: () => storeVersion,
    epoch: () => epoch,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset: () => {
      firstId = nextId;
      entries = [];
      positions = new Map();
      state = { ...freshState(), thoughtWindow: state.thoughtWindow };
      openKey = undefined;
      epoch += 1;
      tell(undefined, storeVersion + 1);
    },
    hold: () => {
      held = { entries: [...entries], positions: new Map(positions), firstId, state, openKey, version: storeVersion, epoch };
    },
    release: () => {
      if (held === undefined) return;
      held = undefined;
      tell(undefined, storeVersion + 1);
    },
    shown: () => shown,
  };

  const heldAt = (frozen: Held, index: number): StoreEntry => {
    const found = frozen.entries[index];
    if (found === undefined) throw new Error(`the transcript has no entry at ${index}`);
    return found;
  };

  const shown: TranscriptStore = {
    ...live,
    count: () => held?.entries.length ?? entries.length,
    at: (index) => (held === undefined ? at(index) : heldAt(held, index)),
    indexOfId: (id) => (held === undefined ? live.indexOfId(id) : id >= held.firstId && id < held.firstId + held.entries.length ? id - held.firstId : undefined),
    byKey: (key) => {
      if (held === undefined) return live.byKey(key);
      const position = held.positions.get(key);
      return position === undefined ? undefined : heldAt(held, position);
    },
    open: () => (held === undefined ? openKey : held.openKey),
    state: () => held?.state ?? state,
    settledAt: (index) => {
      if (held === undefined) return settledAt(index);
      const { entry } = heldAt(held, index);
      return entry.kind === 'banner' ? index < held.entries.length - 1 : settled(entry);
    },
    version: () => held?.version ?? storeVersion,
    epoch: () => held?.epoch ?? epoch,
    subscribe: (listener) =>
      live.subscribe((entryId, version) => {
        if (held === undefined) listener(entryId, version);
      }),
  };

  return live;
};
