import { describe, expect, it } from 'vitest';
import { INDICATOR_DEFINITIONS_VERSION } from '@momonga/protocol';
import type { RunFactsView } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { START_MS, enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';

type FactsStore = {
  cursor(): { definitionsVersion: number; afterEventId: number };
  nextBatch(limit: number): { runIds: string[]; throughEventId: number };
  commit(batch: { rows: readonly RunFactsView[]; unavailable: readonly string[]; throughEventId: number }): void;
  get(runId: string): { kind: 'facts'; facts: RunFactsView } | { kind: 'unavailable' } | undefined;
};

const factsOf = (store: RuntimeStore): FactsStore => (store as unknown as { runFacts: FactsStore }).runFacts;

const completeRun = async (store: RuntimeStore, sessionId: string): Promise<string> => {
  const run = enqueue(store, sessionId);
  const claim = mustClaim(store, 'w1');
  expect((await store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
  return run.id;
};

const factsRow = (runId: string, recoveries: RunFactsView['recoveries'] = []): RunFactsView => ({
  runId,
  rootRunId: runId,
  sessionId: 'sess',
  definitionsVersion: INDICATOR_DEFINITIONS_VERSION,
  modelAlias: 'fm',
  mode: 'default',
  agent: 'build',
  origin: 'cli',
  status: 'COMPLETED',
  createdAt: START_MS,
  endedAt: START_MS + 10,
  elapsedMs: 10,
  humanWaitMs: 0,
  tokensTotal: 0,
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
  basis: { readOnly: 0, rule: 0, mode: 0, hook: 0, classifier: 0, person: 0 },
  declared: false,
  met: true,
  recoveries,
});

describe('migration 24: the facts tables', () => {
  it('creates run_facts, run_recoveries, facts_cursor and permission_reviews', () => {
    const { dbPath } = harness();
    const tables = rawDb(dbPath)
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('run_facts', 'run_recoveries', 'facts_cursor', 'permission_reviews') ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(['facts_cursor', 'permission_reviews', 'run_facts', 'run_recoveries']);
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
    factsOf(store).commit({ rows: batch.runIds.map((runId) => factsRow(runId)), unavailable: [], throughEventId: batch.throughEventId });
    expect(factsOf(store).cursor()).toEqual({ definitionsVersion: INDICATOR_DEFINITIONS_VERSION, afterEventId: batch.throughEventId });
    expect(factsOf(store).nextBatch(2).runIds).toEqual(ids.slice(2));
  });

  it('upserts the rows of a batch before it moves the cursor, so a committed cursor never passes a run without a row', async () => {
    const { store } = harness();
    const runId = await completeRun(store, newSession(store).id);
    const batch = factsOf(store).nextBatch(3);
    const episode = { ordinal: 1, cause: 'process_lost' as const, failedAt: START_MS, progressAt: START_MS + 5, outcome: 'recovered' as const, startedSeq: 2, progressSeq: 3 };
    factsOf(store).commit({ rows: [factsRow(runId, [episode])], unavailable: [], throughEventId: batch.throughEventId });
    expect(factsOf(store).get(runId)).toEqual({ kind: 'facts', facts: factsRow(runId, [episode]) });
  });

  it('reads a cursor of another definitions version as 0, so every run is recomputed at the new version', async () => {
    const { dbPath, store } = harness();
    const session = newSession(store).id;
    const ids = [await completeRun(store, session), await completeRun(store, session)];
    const batch = factsOf(store).nextBatch(3);
    factsOf(store).commit({ rows: ids.map((runId) => factsRow(runId)), unavailable: [], throughEventId: batch.throughEventId });
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
    factsOf(store).commit({ rows: [], unavailable: [poison], throughEventId: first.throughEventId });
    expect(factsOf(store).get(poison)).toEqual({ kind: 'unavailable' });
    expect(factsOf(store).nextBatch(1).runIds).toEqual([later]);
  });
});
