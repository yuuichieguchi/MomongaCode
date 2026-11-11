import type { RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState } from '@momonga/store';
import type { Claim, InheritedWindowReply, RuntimeStore, WindowEntry } from '@momonga/store';

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
};

export type JournalOptions = {
  store: RuntimeStore;
  claim: Claim;
  signal: AbortSignal;
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

const compactionOfInheritance = (store: RuntimeStore, own: RunState): { fromRunId: string; tokens: Pick<Extract<RunEventPayload, { type: 'context.compacted' }>, 'tokensBefore' | 'tokensAfter' | 'tokensAfterEstimated'> } => {
  const inherited = own.inherited;
  if (inherited === undefined) throw new Error(`run ${own.runId} records an inherited compaction without an inheritance`);
  if (inherited.compaction === undefined) return { fromRunId: inherited.fromRunId, tokens: {} };
  const { runId, eventSeq } = inherited.compaction;
  const [event] = store.readRunEvents(runId, eventSeq - 1, 1);
  if (event?.type !== 'context.compacted' || event.seq !== eventSeq) throw new Error(`run ${own.runId} inherits the compaction ${runId}@${eventSeq}, which is not a context.compacted event`);
  const { tokensBefore, tokensAfter, tokensAfterEstimated } = event;
  return {
    fromRunId: runId,
    tokens: { ...(tokensBefore === undefined ? {} : { tokensBefore }), ...(tokensAfter === undefined ? {} : { tokensAfter }), ...(tokensAfterEstimated === undefined ? {} : { tokensAfterEstimated }) },
  };
};

const inheritedCompactionEvent = (store: RuntimeStore, own: RunState, state: RunState): RunEventPayload | undefined => {
  if (own.inherited === undefined || own.inheritedCompactionRecorded === true || own.ownCompactionEventSeq !== undefined || state.summary === undefined) return undefined;
  const { fromRunId, tokens } = compactionOfInheritance(store, own);
  return { type: 'context.inherited_compacted', fromRunId, item: state.summary.item, summary: state.summary.summary, replacedThroughSeq: state.summary.replacedThroughSeq, ...tokens };
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

export const openJournal = async ({ store, claim, signal, lost }: JournalOptions): Promise<Journal> => {
  let own = (await store.load(claim.runId, signal)).state;
  let window: InheritedWindowReply | undefined;
  let merged: { own: RunState; window: InheritedWindowReply; state: RunState } | undefined;

  const sync = (): void => {
    for (;;) {
      const events = store.readRunEvents(claim.runId, own.lastSeq, READ_CHUNK);
      own = events.reduce(foldRunState, own);
      if (events.length < READ_CHUNK) return;
    }
  };

  const journal: Journal = {
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
      const inheritedCompaction = payloads.some((payload) => payload.type === 'model.requested') ? inheritedCompactionEvent(store, own, journal.state) : undefined;
      const result = store.append(claim, inheritedCompaction === undefined ? payloads : [inheritedCompaction, ...payloads]);
      if (result.kind === 'lease_lost') lost();
      sync();
    },
    deliverSteering: () => {
      const result = store.inbox.deliverSteering(claim);
      if (result.kind === 'lease_lost') return lost();
      if (result.delivered.length === 0) return;
      sync();
    },
  };
  return journal;
};
