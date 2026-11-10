import type { RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import type { Claim, InheritedWindowReply, RuntimeStore, WindowEntry } from '@momonga/store';

const SNAPSHOT_INTERVAL_EVENTS = 200;
const READ_CHUNK = 1000;

type HistoryEntry = RunState['history'][number];

export type Journal = {
  readonly state: RunState;
  readonly windowOmitted: boolean;
  needsWindow(): boolean;
  installWindow(reply: InheritedWindowReply): void;
  append(payloads: readonly RunEventPayload[]): void;
  deliverSteering(): void;
  sync(): void;
  verifyLease(): void;
  snapshot(): void;
};

export type JournalOptions = {
  store: RuntimeStore;
  claim: Claim;
  lost(): never;
};

const isStub = (entry: WindowEntry): entry is Extract<WindowEntry, { tokens: number }> => !('item' in entry);

const historyEntryOf = (entry: WindowEntry): HistoryEntry =>
  isStub(entry)
    ? { seq: entry.seq, item: { type: 'function_call_output', call_id: entry.callId, output: '' }, callId: entry.callId, handle: entry.handle, omittedTokens: entry.tokens }
    : entry;

const coversInheritedRange = (own: RunState): boolean => own.summary !== undefined && own.summary.replacedThroughSeq >= own.taskSeq - 1;

const awaitsWindow = (own: RunState): boolean => own.inherited?.form === 'reference' && !coversInheritedRange(own);

const withOwnTruncations = (entries: readonly HistoryEntry[], own: RunState): HistoryEntry[] =>
  (own.inheritedTruncations ?? []).reduce<HistoryEntry[]>((folded, truncation) => {
    const index = folded.findIndex((entry) => entry.callId === truncation.callId && entry.item.type === 'function_call_output');
    if (index < 0) return folded;
    const entry = folded[index] as HistoryEntry;
    const handle = truncation.kind === 'reference' ? (entry.handle ?? truncation.handle) : truncation.handle;
    return folded.map((candidate, position) => (position === index ? { ...candidate, handle } : candidate));
  }, [...entries]);

const mergedState = (own: RunState, window: InheritedWindowReply): RunState => {
  const cut = own.summary?.replacedThroughSeq ?? 0;
  const inherited = withOwnTruncations(window.entries.filter((entry) => entry.seq > cut).map(historyEntryOf), own);
  const summary = own.summary ?? (window.summary === undefined ? undefined : { ...window.summary, item: own.inheritedSummaryItem ?? window.summary.item });
  return {
    ...own,
    history: [...inherited, ...own.history],
    evicted: [...new Set([...window.evicted, ...own.evicted])].sort(),
    ...(summary === undefined ? {} : { summary }),
  };
};

const unreadableState = (own: RunState): RunState => {
  const { history: _history, summary: _summary, evicted: _evicted, ...rest } = own;
  const refuse = (): never => {
    throw new Error(`run ${own.runId} reads its inherited history before the inherited window was installed`);
  };
  return Object.defineProperties(rest, {
    history: { get: refuse, enumerable: true },
    summary: { get: refuse, enumerable: true },
    evicted: { get: refuse, enumerable: true },
  }) as RunState;
};

export const openJournal = ({ store, claim, lost }: JournalOptions): Journal => {
  const loaded = store.load(claim.runId);
  const run = store.getRun(claim.runId);
  if (run === undefined) throw new Error(`unknown run ${claim.runId}`);
  let own = loaded.tail.reduce(foldRunState, loaded.snapshot?.state ?? initialRunState({ runId: run.id, sessionId: run.sessionId }));
  let snapshotSeq = loaded.snapshot?.seq ?? 0;
  let window: InheritedWindowReply | undefined;
  let merged: { own: RunState; window: InheritedWindowReply; state: RunState } | undefined;

  const sync = (): void => {
    for (;;) {
      const events = store.readRunEvents(claim.runId, own.lastSeq, READ_CHUNK);
      own = events.reduce(foldRunState, own);
      if (events.length < READ_CHUNK) return;
    }
  };

  const snapshot = (): void => {
    const result = store.writeSnapshot(claim, own.lastSeq, own);
    if (result.kind === 'lease_lost') lost();
    if (result.kind === 'conflict') throw new Error(`snapshot of run ${claim.runId} at seq ${own.lastSeq} was refused: ${result.reason ?? 'conflict'}`);
    snapshotSeq = own.lastSeq;
  };

  return {
    get state() {
      if (!awaitsWindow(own)) return own;
      if (window === undefined) return unreadableState(own);
      if (merged === undefined || merged.own !== own || merged.window !== window) merged = { own, window, state: mergedState(own, window) };
      return merged.state;
    },
    get windowOmitted() {
      return window?.omittedOlder === true && awaitsWindow(own);
    },
    needsWindow: () => awaitsWindow(own),
    installWindow: (reply) => {
      window = reply;
    },
    sync,
    verifyLease: () => {
      if (store.append(claim, []).kind === 'lease_lost') lost();
    },
    append: (payloads) => {
      const result = store.append(claim, payloads);
      if (result.kind === 'lease_lost') lost();
      sync();
      if (own.lastSeq - snapshotSeq >= SNAPSHOT_INTERVAL_EVENTS) snapshot();
    },
    deliverSteering: () => {
      const result = store.inbox.deliverSteering(claim);
      if (result.kind === 'lease_lost') return lost();
      if (result.delivered.length === 0) return;
      sync();
      if (own.lastSeq - snapshotSeq >= SNAPSHOT_INTERVAL_EVENTS) snapshot();
    },
    snapshot,
  };
};
