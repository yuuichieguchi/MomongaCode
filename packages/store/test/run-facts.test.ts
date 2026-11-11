import { describe, expect, it } from 'vitest';
import { INDICATOR_DEFINITIONS_VERSION } from '@momonga/protocol';
import type { ReportPage, RunCallView, RunFactsView } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { START_MS, enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';

type FactsStore = {
  cursor(): { definitionsVersion: number; afterEventId: number };
  nextBatch(limit: number): { runIds: string[]; throughEventId: number };
  commit(batch: { rows: readonly RunFactsView[]; unavailable: readonly string[]; calls: readonly RunCallView[]; throughEventId: number }): void;
  get(runId: string): { kind: 'facts'; facts: RunFactsView } | { kind: 'unavailable' } | undefined;
  page(after: string, limit: number): ReportPage;
  calls(after: { runId: string; callId: string } | null, limit: number): RunCallView[];
};

const factsOf = (store: RuntimeStore): FactsStore => (store as unknown as { runFacts: FactsStore }).runFacts;

const completeRun = async (store: RuntimeStore, sessionId: string): Promise<string> => {
  const run = await enqueue(store, sessionId);
  const claim = mustClaim(store, 'w1');
  expect((await store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
  return run.id;
};

const factsRow = (runId: string, recoveries: RunFactsView['recoveries'] = []): RunFactsView => ({
  runId,
  rootRunId: runId,
  sessionId: 'sess',
  definitionsVersion: INDICATOR_DEFINITIONS_VERSION,
  model: 'fm',
  mode: 'manual',
  agent: 'build',
  origin: 'cli',
  status: 'COMPLETED',
  createdAt: START_MS,
  endedAt: START_MS + 10,
  elapsedMs: 10,
  humanWaitMs: 0,
  tokensTotal: 0,
  costNano: 0,
  steps: 1,
  limits: {},
  asked: 0,
  elicited: 0,
  authorizationRequired: 0,
  sideEffectingCalls: 0,
  repeatedStarts: 0,
  reconciledAlreadyApplied: 0,
  reconciledNotApplied: 0,
  reconciledUnknown: 0,
  mutated: false,
  owed: false,
  verification: { rounds: 0, firstRoundPassed: null, failedRounds: 0, checkMs: 0, fixRoundTokens: 0 },
  answers: { allowOnce: 0, allowAlways: 0, rejectOnce: 0, rejectAlways: 0 },
  denials: { sandbox: 0, rule: 0, mode: 0, setting: 0, hook: 0, mandate: 0, superseded: 0, held: 0 },
  basis: { readOnly: 0, rule: 0, mode: 0, hook: 0, classifier: 0, person: 0 },
  declared: false,
  met: true,
  recoveries,
});

describe('migration 25: the facts tables', () => {
  it('creates run_facts, run_recoveries, run_calls, facts_cursor and permission_reviews', () => {
    const { dbPath } = harness();
    const tables = rawDb(dbPath)
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('run_calls', 'run_facts', 'run_recoveries', 'facts_cursor', 'permission_reviews', 'run_calls') ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(['facts_cursor', 'permission_reviews', 'run_calls', 'run_facts', 'run_recoveries']);
  });
});

describe('the facts cursor (FactsSweeper.tla)', () => {
  it('starts at (current version, 0) and hands out terminal runs in event order, at most limit at a time', async () => {
    const { store } = harness();
    const session = newSession(store).id;
    const ids = [await completeRun(store, session), await completeRun(store, session), await completeRun(store, session)];
    expect(factsOf(store).cursor()).toEqual({ definitionsVersion: INDICATOR_DEFINITIONS_VERSION, afterEventId: 0 });
    const batch = factsOf(store).nextBatch(2);
    expect(batch.runIds).toEqual(ids.slice(0, 2));
    factsOf(store).commit({ calls: [], rows: batch.runIds.map((runId) => factsRow(runId)), unavailable: [], throughEventId: batch.throughEventId });
    expect(factsOf(store).cursor()).toEqual({ definitionsVersion: INDICATOR_DEFINITIONS_VERSION, afterEventId: batch.throughEventId });
    expect(factsOf(store).nextBatch(2).runIds).toEqual(ids.slice(2));
  });

  it('upserts the rows of a batch before it moves the cursor, so a committed cursor never passes a run without a row', async () => {
    const { store } = harness();
    const runId = await completeRun(store, newSession(store).id);
    const batch = factsOf(store).nextBatch(3);
    const episode = { ordinal: 1, cause: 'process_lost' as const, failedAt: START_MS, progressAt: START_MS + 5, outcome: 'recovered' as const, startedSeq: 2, progressSeq: 3 };
    factsOf(store).commit({ calls: [], rows: [factsRow(runId, [episode])], unavailable: [], throughEventId: batch.throughEventId });
    expect(factsOf(store).get(runId)).toEqual({ kind: 'facts', facts: factsRow(runId, [episode]) });
  });

  it('reads a cursor of another definitions version as 0, so every run is recomputed at the new version', async () => {
    const { dbPath, store } = harness();
    const session = newSession(store).id;
    const ids = [await completeRun(store, session), await completeRun(store, session)];
    const batch = factsOf(store).nextBatch(3);
    factsOf(store).commit({ calls: [], rows: ids.map((runId) => factsRow(runId)), unavailable: [], throughEventId: batch.throughEventId });
    expect(factsOf(store).nextBatch(3).runIds).toEqual([]);
    rawDb(dbPath).prepare('UPDATE facts_cursor SET definitions_version = ?').run(INDICATOR_DEFINITIONS_VERSION - 1);
    expect(factsOf(store).cursor()).toEqual({ definitionsVersion: INDICATOR_DEFINITIONS_VERSION, afterEventId: 0 });
    expect(factsOf(store).nextBatch(3).runIds).toEqual(ids);
  });

  it('records a run whose fold threw as unavailable and lets the cursor pass it', async () => {
    const { store } = harness();
    const session = newSession(store).id;
    const poison = await completeRun(store, session);
    const later = await completeRun(store, session);
    const first = factsOf(store).nextBatch(1);
    expect(first.runIds).toEqual([poison]);
    factsOf(store).commit({ calls: [], rows: [], unavailable: [poison], throughEventId: first.throughEventId });
    expect(factsOf(store).get(poison)).toEqual({ kind: 'unavailable' });
    expect(factsOf(store).nextBatch(1).runIds).toEqual([later]);
  });
});

describe('decision 57: run_calls rows are written with the facts', () => {
  const callOf = (runId: string, callId: string, overrides: Partial<RunCallView> = {}): RunCallView => ({ runId, callId, basis: 'rule', sideEffect: 'write', asked: false, ...overrides });

  it('writes the call rows in the transaction of the facts row and the cursor, and pages them by (run id, call id)', async () => {
    const { store } = harness();
    const session = newSession(store).id;
    const ids = [await completeRun(store, session), await completeRun(store, session)];
    const batch = factsOf(store).nextBatch(3);
    const calls = [callOf(ids[0] as string, 'a'), callOf(ids[0] as string, 'b', { basis: null, sideEffect: null }), callOf(ids[1] as string, 'a', { asked: true, basis: 'person' })];
    factsOf(store).commit({ rows: ids.map((runId) => factsRow(runId)), calls, unavailable: [], throughEventId: batch.throughEventId });
    const all = factsOf(store).calls(null, 10);
    expect(all).toEqual([...calls].sort((left, right) => (left.runId + left.callId < right.runId + right.callId ? -1 : 1)));
    expect(factsOf(store).calls({ runId: ids[0] as string, callId: 'a' }, 2)).toEqual(all.slice(1, 3));
  });

  it('replaces the call rows of a run when its facts are recomputed, and keeps none for an unavailable run', async () => {
    const { dbPath, store } = harness();
    const session = newSession(store).id;
    const [runId, poison] = [await completeRun(store, session), await completeRun(store, session)];
    const batch = factsOf(store).nextBatch(3);
    factsOf(store).commit({ rows: [factsRow(runId as string)], calls: [callOf(runId as string, 'a'), callOf(runId as string, 'b')], unavailable: [], throughEventId: batch.throughEventId });
    rawDb(dbPath).prepare('UPDATE facts_cursor SET definitions_version = definitions_version - 1').run();
    const again = factsOf(store).nextBatch(3);
    factsOf(store).commit({ rows: [factsRow(runId as string)], calls: [callOf(runId as string, 'c')], unavailable: [poison as string], throughEventId: again.throughEventId });
    expect(factsOf(store).calls(null, 10)).toEqual([callOf(runId as string, 'c')]);
  });
});

describe('decision 55: a page carries the unavailable runs with their roots', () => {
  it('lists an unavailable run on its page beside the rows, with the root of its tree, and the cursor passes it', async () => {
    const { store } = harness();
    const session = newSession(store).id;
    const ids = [await completeRun(store, session), await completeRun(store, session), await completeRun(store, session)];
    const batch = factsOf(store).nextBatch(5);
    factsOf(store).commit({ rows: [factsRow(ids[0] as string), factsRow(ids[2] as string)], calls: [], unavailable: [ids[1] as string], throughEventId: batch.throughEventId });
    const page = factsOf(store).page('', 10);
    expect(page.rows.map((row) => row.runId)).toEqual([ids[0], ids[2]]);
    expect(page.unavailable).toEqual([{ runId: ids[1], rootRunId: ids[1] }]);
    expect(page.nextCursor).toBeNull();
  });
});

describe('migration 38: the money and the mandate figures of a run', () => {
  it('keeps the money spent, the money limit and the delegation figures of a run, and leaves a run without a mandate without them', async () => {
    const { store } = harness();
    const session = newSession(store);
    const mandated = await completeRun(store, session.id);
    const plain = await completeRun(store, session.id);
    const batch = factsOf(store).nextBatch(10);
    const withMandate: RunFactsView = { ...factsRow(mandated), costNano: 4200, limits: { maxCostNano: 5000 }, delegation: { held: 2, resolvedByPerson: 1, denied: 3, waited: true, holdLatencyMs: 700, workDuringHolds: { modelSteps: 2, toolCalls: 1 } } };

    factsOf(store).commit({ calls: [], rows: [withMandate, factsRow(plain)], unavailable: [], throughEventId: batch.throughEventId });

    expect(factsOf(store).get(mandated)).toEqual({ kind: 'facts', facts: withMandate });
    expect(factsOf(store).get(plain)).toEqual({ kind: 'facts', facts: factsRow(plain) });
  });
});
