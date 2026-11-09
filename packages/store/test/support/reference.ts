import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '@momonga/foundation';
import { findDanglingOutput } from '@momonga/protocol';
import type { InputItem, PermissionMode, RunEvent, RunEventPayload, RunState, StopReason } from '@momonga/protocol';
import { JournalThreadError, applyInheritance, createJournalReader, foldRunState, initialRunState, knownValue, projectInheritance } from '@momonga/store';
import { retractsTask } from '../../src/inherit.ts';
import type { Claim, ContributionPreparer, InheritanceOutcome, JournalReaderOptions, Run, RuntimeStore } from '@momonga/store';
import { createFakeClock, fixtureCompactionItem } from '@momonga/testkit';
import type { FakeClock } from '@momonga/testkit';
import { START_MS, TIMEOUT_MS, makeStoreDir, mustClaim, mustRun, newSession, noJournalFacts, openStoreAt, registerCleanup } from '../helpers.ts';
import { assistantItem, callItem } from '../inherit-fixtures.ts';
import type { InheritedEvent } from '../inherit-fixtures.ts';
import type { Random } from './seeded.ts';

export const LONG_LEASE_MS = 10 * TIMEOUT_MS;
export const UNBOUNDED_WINDOW = 1_000_000_000;
export const FLOOR_TOKENS = 1;

const USAGE = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };

type HistoryEntry = RunState['history'][number];

export type Synthesised = { seq: number; item: InputItem; callId?: string };

export type ViaLink = { runId: string; lastSeq: number; nextItemSeq: number; omitSeqs: number[]; synthesised: Synthesised[] };

export type ReferenceEvent = Omit<InheritedEvent, 'history' | 'summary' | 'evicted'> & {
  form: 'reference';
  fromNextItemSeq: number;
  compaction?: { runId: string; eventSeq: number };
  omitSeqs: number[];
  synthesised: Synthesised[];
  via: ViaLink[];
  itemCount: number;
};

export type EvictedStub = { seq: number; callId: string; handle: string; tokens: number };

export type WindowEntry = HistoryEntry | EvictedStub;

export type InheritedWindowReply = {
  lastSeq: number;
  summary?: RunState['summary'];
  entries: WindowEntry[];
  evicted: string[];
  omittedOlder: boolean;
};

export type InheritPlanReply =
  | { kind: 'ready'; payload: ReferenceEvent; walked: { runId: string; lastSeq: number; status: string }[] }
  | { kind: 'none' }
  | { kind: 'already' }
  | { kind: 'conflict'; reason?: string };

export type WindowRequest = { runId: string; windowTokens: number; floorTokens: number };

export type PlanRequest = { runId: string; mode: PermissionMode };

export type ReferenceReader = {
  planInheritance(request: PlanRequest): InheritPlanReply;
  readInheritedWindow(request: WindowRequest): InheritedWindowReply;
};

export type ReferenceReaderOptions = JournalReaderOptions & { onHop?: (runId: string) => void };

export const referenceReaderOf = (reader: unknown): ReferenceReader => {
  const candidate = reader as Partial<ReferenceReader>;
  if (typeof candidate.readInheritedWindow !== 'function') throw new Error('the journal reader has no readInheritedWindow');
  if (typeof candidate.planInheritance !== 'function') throw new Error('the journal reader has no planInheritance');
  return reader as ReferenceReader;
};

export const referenceReader = (db: DatabaseSync, options: ReferenceReaderOptions = {}): ReferenceReader =>
  referenceReaderOf(createJournalReader(db, options as JournalReaderOptions));

export const withReader = <T,>(dbPath: string, read: (reader: ReferenceReader) => T, options: ReferenceReaderOptions = {}): T => {
  const db = openDatabase(dbPath);
  try {
    return read(referenceReader(db, options));
  } finally {
    db.close();
  }
};

export type ReferenceFacts = {
  inheritPlan(request: PlanRequest, signal?: AbortSignal): Promise<InheritPlanReply>;
  inheritedWindow(request: WindowRequest, signal?: AbortSignal): Promise<InheritedWindowReply>;
};

const measuredNothing = (dbPath: string) => async (request: { runId: string }) => {
  const db = openDatabase(dbPath);
  try {
    const row = db.prepare('SELECT last_seq FROM runs WHERE id = ?').get(request.runId) as { last_seq: number } | undefined;
    if (row === undefined) throw new JournalThreadError(`unknown run ${request.runId}`);
    return { lastSeq: row.last_seq };
  } finally {
    db.close();
  }
};

export const referencePreparer = (dbPath: string, calls: { plan: number; window: number } = { plan: 0, window: 0 }): ContributionPreparer => {
  const facts: ReferenceFacts = {
    inheritPlan: async (request) => {
      calls.plan += 1;
      return withReader(dbPath, (reader) => reader.planInheritance(request));
    },
    inheritedWindow: async (request) => {
      calls.window += 1;
      return withReader(dbPath, (reader) => reader.readInheritedWindow(request));
    },
  };
  return { ...noJournalFacts, measure: measuredNothing(dbPath), ...facts } as unknown as ContributionPreparer;
};

export type ReferenceHarness = { dir: string; dbPath: string; clock: FakeClock; store: RuntimeStore; calls: { plan: number; window: number }; sessionId: string };

export const referenceHarness = (): ReferenceHarness => {
  const dir = makeStoreDir();
  const dbPath = path.join(dir, 'runtime.db');
  const clock = createFakeClock(START_MS);
  const calls = { plan: 0, window: 0 };
  const store = openStoreAt(dbPath, clock, { leaseMs: LONG_LEASE_MS, preparer: referencePreparer(dbPath, calls) });
  const sessionId = newSession(store).id;
  return { dir, dbPath, clock, store, calls, sessionId };
};

export const eventsOf = (store: RuntimeStore, runId: string): RunEvent[] => {
  const all: RunEvent[] = [];
  for (;;) {
    const page = store.readRunEvents(runId, all.at(-1)?.seq ?? 0, 1000);
    all.push(...page);
    if (page.length < 1000) return all;
  }
};

export const inheritedEventsOf = (store: RuntimeStore, runId: string): RunEvent[] => eventsOf(store, runId).filter((event) => event.type === 'context.inherited');

export const referenceOf = (store: RuntimeStore, runId: string): ReferenceEvent & RunEvent => {
  const found = inheritedEventsOf(store, runId);
  if (found.length !== 1) throw new Error(`run ${runId} has ${found.length} context.inherited events`);
  return found[0] as unknown as ReferenceEvent & RunEvent;
};

const payloadOfEvent = (event: RunEvent): RunEventPayload => {
  const { id: _id, runId: _runId, sessionId: _sessionId, seq: _seq, step: _step, leaseToken: _leaseToken, createdAt: _createdAt, ...payload } = event as RunEvent & Record<string, unknown>;
  return payload as unknown as RunEventPayload;
};

export const foldEvents = (run: Run, events: readonly RunEvent[]): RunState => events.reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId }));

export const outcomeOf = (run: Run): InheritanceOutcome => ({
  status: run.status as InheritanceOutcome['status'],
  ...(run.stopReason === undefined ? {} : { stopReason: knownValue(run.stopReason, `the stop reason of run ${run.id}`) }),
  ...(run.error === undefined ? {} : { errorCode: run.error.code }),
});

const isOldShape = (event: RunEvent): boolean => 'history' in event;

const carriedSkillsOf = (store: RuntimeStore, runId: string): string[] => {
  const [event] = inheritedEventsOf(store, runId);
  const skills = (event as unknown as { activatedSkills?: { name: string }[] } | undefined)?.activatedSkills ?? [];
  return skills.map((skill) => skill.name);
};

const TERMINAL = ['COMPLETED', 'STOPPED', 'FAILED', 'CANCELLED'];

export const oracleProjection = (store: RuntimeStore, child: Run, mode: PermissionMode): InheritedEvent => {
  const unmaterialised: Run[] = [];
  let base: Run;
  for (let cursor = child; ; ) {
    if (cursor.previousRunId === null) throw new Error(`run ${cursor.id} has no previous run`);
    const previous = mustRun(store, cursor.previousRunId);
    if (!TERMINAL.includes(previous.status)) throw new Error(`previous run ${previous.id} is ${previous.status}`);
    if (previous.history === 'fresh' || previous.previousRunId === null || inheritedEventsOf(store, previous.id).length > 0) {
      base = previous;
      break;
    }
    unmaterialised.push(previous);
    cursor = previous;
  }
  let sourceRun = base;
  let sourceState = oracleState(store, base.id);
  let carriedSkills = carriedSkillsOf(store, base.id);
  for (const candidate of unmaterialised.reverse()) {
    const candidateState = oracleState(store, candidate.id);
    if (retractsTask(candidateState, outcomeOf(candidate))) continue;
    const payload = projectInheritance(sourceState, { ...outcomeOf(sourceRun), carriedSkills }, { kind: 'intermediate' });
    sourceState = applyInheritance(candidateState, payload);
    carriedSkills = (payload.activatedSkills ?? []).map((skill) => skill.name);
    sourceRun = candidate;
  }
  return projectInheritance(sourceState, { ...outcomeOf(sourceRun), carriedSkills }, { kind: 'final', currentMode: mode }) as InheritedEvent;
};

export const oracleState = (store: RuntimeStore, runId: string, throughSeq = Number.POSITIVE_INFINITY): RunState => {
  const run = mustRun(store, runId);
  const events = eventsOf(store, runId).filter((event) => event.seq <= throughSeq);
  const replaced = events.map((event) => {
    if (event.type !== 'context.inherited' || isOldShape(event)) return event;
    const mode = (event as unknown as { mode?: PermissionMode }).mode ?? 'default';
    const { form: _form, ...rest } = event as RunEvent & { form?: string };
    return { ...rest, ...oracleProjection(store, run, mode) } as unknown as RunEvent;
  });
  return foldEvents(run, replaced);
};

export const ownState = (store: RuntimeStore, runId: string): RunState => foldEvents(mustRun(store, runId), eventsOf(store, runId));

export const recordedTokens = (store: RuntimeStore, sessionId: string): Map<string, number> => {
  const tokens = new Map<string, number>();
  for (const run of store.listRuns(sessionId)) {
    for (const event of eventsOf(store, run.id)) {
      const recorded = (event as unknown as { tokens?: number }).tokens;
      if (event.type === 'context.truncated' && event.kind === 'omitted' && recorded !== undefined) tokens.set(event.callId, recorded);
    }
  }
  return tokens;
};

export const isStub = (entry: WindowEntry): entry is EvictedStub => !('item' in entry);

export const expectedEntries = (oracle: readonly HistoryEntry[], evicted: readonly string[], tokens: ReadonlyMap<string, number>): WindowEntry[] =>
  oracle.map((entry) => {
    const recorded = entry.callId === undefined ? undefined : tokens.get(entry.callId);
    if (entry.item.type === 'function_call_output' && entry.callId !== undefined && entry.handle !== undefined && evicted.includes(entry.callId) && recorded !== undefined) {
      return { seq: entry.seq, callId: entry.callId, handle: entry.handle, tokens: recorded };
    }
    return entry;
  });

export const deliveredCallIds = (entries: readonly WindowEntry[]): Set<string> =>
  new Set(entries.flatMap((entry) => (isStub(entry) ? [entry.callId] : entry.callId === undefined ? [] : [entry.callId])));

export type ChainBuilder = ReturnType<typeof chainBuilder>;

export const chainBuilder = (h: ReferenceHarness) => {
  let calls = 0;
  let steps = 0;
  let messages = 0;
  const outputs = new Map<string, string>();

  const createRun = (input: string, options: { history?: 'inherit' | 'fresh'; timeoutMs?: number } = {}): Run => {
    const result = h.store.createRunAndEnqueue(h.sessionId, {
      input,
      timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
      limits: {},
      pins: {},
      ...(options.history === undefined ? {} : { history: options.history }),
    });
    if (result.kind !== 'created') throw new Error(`expected a created run, got ${result.kind}`);
    return result.run;
  };

  const append = (claim: Claim, payloads: readonly RunEventPayload[]): void => {
    const result = h.store.append(claim, payloads);
    if (result.kind !== 'ok') throw new Error(`append to run ${claim.runId} returned ${result.kind}`);
  };

  const nextStep = (): number => {
    steps += 1;
    return steps;
  };

  const requested = (step: number): RunEventPayload => ({ type: 'model.requested', step, attempt: 1, digest: `d${step}`, body: { tool_choice: 'auto' } });

  const responded = (step: number, output: unknown[]): RunEventPayload => ({ type: 'model.responded', step, attempt: 1, response: { status: 'completed', output, usage: USAGE } } as RunEventPayload);

  const text = (claim: Claim, chars = 12): void => {
    const step = nextStep();
    messages += 1;
    append(claim, [requested(step), responded(step, [assistantItem(`m${messages}`, `answer ${messages} ${'a'.repeat(chars)}`)])]);
  };

  const tool = (claim: Claim, options: { outputChars?: number; evict?: boolean; withTokens?: boolean } = {}): string => {
    const step = nextStep();
    calls += 1;
    const callId = `c${calls}`;
    const output = `out ${callId} ${'o'.repeat(options.outputChars ?? 40)}`;
    outputs.set(callId, output);
    append(claim, [
      requested(step),
      responded(step, [callItem(callId)]),
      { type: 'tool.call', callId, providerCallId: callId, name: 'Write', kind: 'edit', title: 'Write x.txt', rawInput: { file_path: '/work/a/x.txt' } },
      { type: 'tool.started', callId, idemKey: `k-${callId}` },
      { type: 'tool.completed', callId, status: 'completed', output },
    ]);
    if (options.evict === true) evict(claim, callId, options.withTokens === false ? undefined : Math.ceil(output.length / 4));
    return callId;
  };

  const evict = (claim: Claim, callId: string, tokens?: number): void => {
    const inherited = oracleState(h.store, claim.runId).history.find((entry) => entry.item.type === 'function_call_output' && entry.item.call_id === callId)?.item;
    const output = outputs.get(callId) ?? (inherited?.type === 'function_call_output' && typeof inherited.output === 'string' ? inherited.output : undefined);
    if (output === undefined) throw new Error(`no output is known for call ${callId}`);
    const { handle } = h.store.blobs.put(output, { mediaType: 'text/plain' } as never);
    append(claim, [{ type: 'context.truncated', callId, handle, kind: 'omitted', ...(tokens === undefined ? {} : { tokens }) } as RunEventPayload]);
  };

  const openCall = (claim: Claim, started: boolean): string => {
    const step = nextStep();
    calls += 1;
    const callId = `c${calls}`;
    append(claim, [
      requested(step),
      responded(step, [callItem(callId)]),
      { type: 'tool.call', callId, providerCallId: callId, name: 'Write', kind: 'edit', title: 'Write x.txt', rawInput: { file_path: '/work/a/x.txt' } },
      ...(started ? [{ type: 'tool.started', callId, idemKey: `k-${callId}` } as RunEventPayload] : []),
    ]);
    return callId;
  };

  const partial = (claim: Claim): void => {
    const step = nextStep();
    append(claim, [requested(step), { type: 'agent.message.delta', step, attempt: 1, itemId: `p${step}`, text: 'half an answer' }]);
  };

  const compactionCut = (runId: string): number | undefined => {
    const history = oracleState(h.store, runId).history;
    const cuts = history.flatMap((entry, index) => (index < history.length - 1 && findDanglingOutput(history.slice(index + 1)) === undefined ? [entry.seq] : []));
    return cuts.at(Math.floor(cuts.length / 2));
  };

  const compact = (claim: Claim, throughSeq: number, rejected = false): void => {
    const summary = `summary through ${throughSeq}`;
    append(claim, [
      { type: 'context.compacted', item: fixtureCompactionItem(`cmp-${throughSeq}`, summary), summary, replacedThroughSeq: throughSeq },
      ...(rejected ? [{ type: 'context.compaction_rejected', item: { type: 'message', role: 'user', content: `rejected ${summary}` } } as RunEventPayload] : []),
    ]);
  };

  const started = (claim: Claim, mode: PermissionMode): void => append(claim, [{ type: 'run.started', attempt: 1, now: h.clock.now(), pins: { model: 'fm' }, mode }]);

  type Ending = { to: 'COMPLETED' } | { to: 'STOPPED'; stopReason: StopReason } | { to: 'FAILED'; code: string } | { to: 'CANCELLED' };

  const end = async (claim: Claim, ending: Ending): Promise<void> => {
    if (ending.to === 'CANCELLED') {
      const requestedCancel = h.store.requestCancel(claim.runId);
      if (requestedCancel.kind !== 'ok') throw new Error(`cancel of ${claim.runId} returned ${requestedCancel.kind}`);
      const result = await h.store.transition(claim, ['CANCELLING'], 'CANCELLED');
      if (result.kind !== 'ok') throw new Error(`cancel transition returned ${result.kind}`);
      return;
    }
    const patch = ending.to === 'STOPPED' ? { stopReason: ending.stopReason } : ending.to === 'FAILED' ? { error: { code: ending.code, message: 'x' } } : undefined;
    const result = await h.store.transition(claim, ['RUNNING'], ending.to, patch as never);
    if (result.kind !== 'ok') throw new Error(`transition of ${claim.runId} returned ${result.kind}`);
  };

  const claimNext = (runId: string): Claim => {
    const claim = mustClaim(h.store, 'w1');
    if (claim.runId !== runId) throw new Error(`claimed ${claim.runId}, expected ${runId}`);
    return claim;
  };

  const inherit = async (claim: Claim, mode: PermissionMode): Promise<unknown> => h.store.inheritContext(claim, { mode });

  const inheritOldShape = (claim: Claim, mode: PermissionMode): void => {
    append(claim, [oracleProjection(h.store, mustRun(h.store, claim.runId), mode)]);
  };

  return { createRun, append, text, tool, evict, openCall, partial, compactionCut, compact, started, end, claimNext, inherit, inheritOldShape };
};

export type Ending = Parameters<ChainBuilder['end']>[1];

export const answeredRun = async (h: ReferenceHarness, b: ChainBuilder, task: string, body: (claim: Claim) => void, options: { fresh?: boolean; oldShape?: boolean; mode?: PermissionMode; ending?: Ending } = {}): Promise<Run> => {
  const run = b.createRun(task, options.fresh === true ? { history: 'fresh' } : {});
  const claim = b.claimNext(run.id);
  const mode = options.mode ?? 'default';
  if (options.fresh !== true && run.previousRunId !== null) {
    if (options.oldShape === true) b.inheritOldShape(claim, mode);
    else await b.inherit(claim, mode);
  }
  b.started(claim, mode);
  body(claim);
  await b.end(claim, options.ending ?? { to: 'COMPLETED' });
  return mustRun(h.store, run.id);
};

export const generatedRun = async (h: ReferenceHarness, b: ChainBuilder, random: Random, index: number, options: { fresh?: boolean; oldShape?: boolean; recordTokens?: boolean } = {}): Promise<Run> => {
  const recordTokens = (): boolean => {
    const drawn = random.chance(0.8);
    return options.recordTokens ?? drawn;
  };
  const mode: PermissionMode = random.chance(0.2) ? 'plan' : 'default';
  const run = b.createRun(`task ${index}`, options.fresh === true ? { history: 'fresh' } : {});
  const claim = b.claimNext(run.id);
  if (options.fresh !== true && run.previousRunId !== null) {
    if (options.oldShape === true) b.inheritOldShape(claim, mode);
    else await b.inherit(claim, mode);
  }
  b.started(claim, mode);
  const inheritedOutput = (): string | undefined => {
    const state = oracleState(h.store, run.id);
    return state.history.find((entry) => entry.item.type === 'function_call_output' && entry.seq < state.taskSeq && entry.handle === undefined)?.callId;
  };
  const count = random.int(0, 6);
  for (let at = 0; at < count; at += 1) {
    const roll = random.next();
    if (roll < 0.35) b.text(claim, random.int(4, 400));
    else if (roll < 0.8) b.tool(claim, { outputChars: random.int(4, 2000), evict: random.chance(0.4), withTokens: recordTokens() });
    else if (roll < 0.9) {
      const cut = b.compactionCut(run.id);
      if (cut !== undefined) b.compact(claim, cut, random.chance(0.3));
    } else {
      const target = inheritedOutput();
      const withTokens = recordTokens();
      if (target !== undefined) b.evict(claim, target, withTokens ? 9 : undefined);
    }
  }
  const tail = random.next();
  if (tail < 0.1) b.openCall(claim, random.chance(0.5));
  else if (tail < 0.2) b.partial(claim);
  const endings: Ending[] = [
    { to: 'COMPLETED' },
    { to: 'COMPLETED' },
    { to: 'STOPPED', stopReason: 'timeout' },
    { to: 'STOPPED', stopReason: 'loop' },
    { to: 'FAILED', code: 'server_error' },
    { to: 'CANCELLED' },
  ];
  await b.end(claim, random.pick(endings));
  return mustRun(h.store, run.id);
};

export const closeAll = (dbs: DatabaseSync[]): void => registerCleanup(() => dbs.forEach((db) => db.isOpen && db.close()));
