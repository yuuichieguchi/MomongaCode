import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cfgNames } from '../../../../test/formal/cfg-names.ts';
import * as runtime from '@momonga/runtime';
import { FACTS_SWEEP_BATCH_RUNS, INDICATOR_DEFINITIONS_VERSION } from '@momonga/protocol';
import type { RunCallView, RunFactsView } from '@momonga/protocol';
import { afterMicrotasks, createFakeClock, createFakeTimers } from '@momonga/testkit';
import { START_MS } from './helpers.ts';
import { enqueue, harness, harnessFrom, migratedDatabase, mustClaim, newSession, rawDb } from '../../../store/test/helpers.ts';
import * as storeModule from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';

type Sweeper = { close(): Promise<void> };

const startFactsSweeper = (options: Record<string, unknown>): Sweeper => {
  const start = (runtime as Record<string, unknown>)['startFactsSweeper'];
  if (typeof start !== 'function') throw new Error('@momonga/runtime does not export startFactsSweeper');
  return start(options) as Sweeper;
};

type RefusalClass = new (message: string) => Error;

const factsRefusedError = (): RefusalClass => {
  const refusal = (storeModule as Record<string, unknown>)['FactsRefusedError'];
  if (typeof refusal !== 'function') throw new Error('@momonga/store does not export FactsRefusedError');
  return refusal as RefusalClass;
};

type Commit = { rows: readonly RunFactsView[]; calls: readonly RunCallView[]; unavailable: readonly string[]; throughEventId: number };

const recordOf = (facts: RunFactsView, calls: readonly RunCallView[] = []) => ({ facts, calls });

const factsStore = (runIds: readonly string[]) => {
  const commits: Commit[] = [];
  let afterEventId = 0;
  return {
    commits,
    covered: (): string[] => commits.flatMap((commit) => [...commit.rows.map((row) => row.runId), ...commit.unavailable]),
    store: {
      runFacts: {
        cursor: () => ({ definitionsVersion: 1, afterEventId }),
        nextBatch: (limit: number) => {
          const ids = runIds.slice(afterEventId, afterEventId + limit);
          return { runIds: ids, eventIds: ids.map((_, index) => afterEventId + index + 1), afterEventId, throughEventId: afterEventId + ids.length };
        },
        commit: (commit: Commit) => {
          commits.push(commit);
          afterEventId = commit.throughEventId;
        },
      },
    },
  };
};

const rowFor = (runId: string): RunFactsView => ({ runId }) as RunFactsView;

const fullRow = (runId: string, sessionId: string): RunFactsView => ({
  runId,
  rootRunId: runId,
  sessionId,
  definitionsVersion: INDICATOR_DEFINITIONS_VERSION,
  model: 'fm',
  mode: 'manual',
  agent: 'build',
  origin: 'cli',
  status: 'COMPLETED',
  createdAt: START_MS,
  endedAt: START_MS,
  elapsedMs: 0,
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
  recoveries: [],
});

const tick = async (timers: ReturnType<typeof createFakeTimers>): Promise<void> => {
  timers.advance(1000);
  await afterMicrotasks();
  await afterMicrotasks();
};

describe('startFactsSweeper (FactsSweeper.tla)', () => {
  it('sends at most FACTS_SWEEP_BATCH_RUNS runFacts requests per tick and commits each batch once', async () => {
    const timers = createFakeTimers(createFakeClock(START_MS));
    const ids = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];
    const fake = factsStore(ids);
    const requests: string[][] = [];
    let current: string[] = [];
    const thread = { runFacts: async (runId: string) => (current.push(runId), recordOf(rowFor(runId))) };
    const sweeper = startFactsSweeper({ store: fake.store, thread, timers, intervalMs: 1000, batchSize: FACTS_SWEEP_BATCH_RUNS, onError: () => undefined });
    for (let round = 0; round < 3; round += 1) {
      current = [];
      await tick(timers);
      requests.push(current);
    }
    await sweeper.close();
    expect(requests.map((batch) => batch.length)).toEqual([3, 3, 1]);
    expect(fake.commits.map((commit) => commit.throughEventId)).toEqual([3, 6, 7]);
    expect(fake.covered()).toEqual(ids);
  });

  it('records a run whose fold refuses its journal as unavailable and passes it, so a later run is not blocked', async () => {
    const FactsRefused = factsRefusedError();
    const timers = createFakeTimers(createFakeClock(START_MS));
    const fake = factsStore(['r1', 'poison', 'r3', 'r4']);
    const errors: unknown[] = [];
    const thread = {
      runFacts: async (runId: string) => {
        if (runId === 'poison') throw new FactsRefused('the fold of poison refused the journal');
        return recordOf(rowFor(runId));
      },
    };
    const sweeper = startFactsSweeper({ store: fake.store, thread, timers, intervalMs: 1000, batchSize: 3, onError: (error: unknown) => errors.push(error) });
    await tick(timers);
    await tick(timers);
    await sweeper.close();
    expect(fake.commits[0]).toEqual({ rows: [rowFor('r1'), rowFor('r3')], calls: [], unavailable: ['poison'], throughEventId: 3 });
    expect(fake.covered().sort()).toEqual(['poison', 'r1', 'r3', 'r4']);
    expect(timers.pending()).toEqual([]);
  });

  it('coverage converges through the real store: with no new terminal runs, every terminal run gets a row or an unavailable mark, again after a definitions version change', async () => {
    const FactsRefused = factsRefusedError();
    const { dbPath, store, clock } = harness();
    const timers = createFakeTimers(clock);
    const session = newSession(store).id;
    const complete = async (): Promise<string> => {
      const run = await enqueue(store, session);
      const claim = mustClaim(store, 'w1');
      expect((await store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
      return run.id;
    };
    const ids = [await complete(), await complete(), await complete(), await complete()];
    const poison = ids[1] as string;
    const requested: string[] = [];
    const thread = {
      runFacts: async (runId: string) => {
        requested.push(runId);
        if (runId === poison) throw new FactsRefused('the fold refused the journal');
        return recordOf(fullRow(runId, session), [{ runId, callId: 'call-1', basis: 'rule', sideEffect: 'write', asked: false }]);
      },
    };
    const facts = (store as unknown as { runFacts: { get(runId: string): unknown } }).runFacts;
    const sweeper = startFactsSweeper({ store: store as RuntimeStore, thread, timers, intervalMs: 1000, batchSize: FACTS_SWEEP_BATCH_RUNS, onError: () => undefined });
    await tick(timers);
    ids.push(await complete());
    for (let round = 0; round < 4; round += 1) await tick(timers);
    expect(ids.map((runId) => facts.get(runId) === undefined)).toEqual(ids.map(() => false));
    expect(facts.get(poison)).toEqual({ kind: 'unavailable' });
    const stored = (store as unknown as { runFacts: { calls(after: null, limit: number): RunCallView[] } }).runFacts.calls(null, 100);
    expect(stored.map((call) => call.runId).sort()).toEqual(ids.filter((runId) => runId !== poison).sort());
    const before = requested.length;
    await tick(timers);
    expect(requested.length).toBe(before);
    rawDb(dbPath).prepare('UPDATE facts_cursor SET definitions_version = definitions_version - 1').run();
    for (let round = 0; round < 3; round += 1) await tick(timers);
    expect(requested.slice(before).sort()).toEqual([...ids].sort());
    await sweeper.close();
  });

  it('gap A1: a request failure that is not a fold refusal writes no unavailable mark, keeps the cursor before the run, and the run is asked again', async () => {
    const timers = createFakeTimers(createFakeClock(START_MS));
    const fake = factsStore(['r1', 'r2', 'r3', 'r4']);
    const requested: string[][] = [];
    let current: string[] = [];
    let failures = 0;
    const thread = {
      runFacts: async (runId: string) => {
        current.push(runId);
        if (runId === 'r2' && failures === 0) {
          failures += 1;
          throw new storeModule.JournalThreadError('journal thread was silent for 1000 ms');
        }
        return recordOf(rowFor(runId));
      },
    };
    const sweeper = startFactsSweeper({ store: fake.store, thread, timers, intervalMs: 1000, batchSize: 3, onError: () => undefined });
    current = [];
    await tick(timers);
    requested.push(current);
    expect(fake.covered()).not.toContain('r2');
    expect(fake.commits.every((commit) => commit.throughEventId < 2)).toBe(true);
    for (let round = 0; round < 3; round += 1) {
      current = [];
      await tick(timers);
      requested.push(current);
    }
    await sweeper.close();
    expect(requested[1]?.[0]).toBe('r2');
    expect(fake.commits.flatMap((commit) => commit.unavailable)).toEqual([]);
    expect([...new Set(fake.covered())].sort()).toEqual(['r1', 'r2', 'r3', 'r4']);
  });

  describe('the sweeper on the cases of specs/tla/FactsSweeper.tla, through the real store', () => {
    const model = cfgNames(path.resolve(import.meta.dirname, '..', '..', '..', '..', 'specs', 'tla'), 'FactsSweeper');
    const runCount = (model.constants['Runs'] ?? '').split(',').length;
    const batchSize = Number(model.constants['BatchSize']);

    const world = async (migrated: string) => {
      const { dbPath, store, clock } = harnessFrom(migrated);
      const timers = createFakeTimers(clock);
      const session = newSession(store).id;
      const terminalEvent = new Map<string, number>();
      const sessionOf = new Map<string, string>();
      const complete = async (sessionId = session): Promise<string> => {
        const run = await enqueue(store, sessionId);
        const claim = mustClaim(store, 'w1');
        expect((await store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
        const last = rawDb(dbPath).prepare('SELECT MAX(id) AS id FROM events WHERE run_id = ?').get(run.id) as { id: number };
        terminalEvent.set(run.id, last.id);
        sessionOf.set(run.id, sessionId);
        return run.id;
      };
      const facts = (store as unknown as { runFacts: { get(runId: string): { kind: string } | undefined; cursor(): { definitionsVersion: number; afterEventId: number } } }).runFacts;
      const invariantProblems = (poison: ReadonlySet<string>, label: string): string[] => {
        const problems: string[] = [];
        const terminal = new Set(terminalEvent.keys());
        for (const row of rawDb(dbPath).prepare('SELECT run_id FROM run_facts').all() as Array<{ run_id: string }>) {
          if (!terminal.has(row.run_id) || store.getRun(row.run_id) === undefined) problems.push(`${label}: RowsOnlyForTerminal, a row for ${row.run_id}`);
        }
        const cursor = facts.cursor();
        for (const [runId, eventId] of terminalEvent) {
          if (store.getRun(runId) === undefined) continue;
          const row = facts.get(runId);
          if (row?.kind === 'unavailable' && !poison.has(runId)) problems.push(`${label}: UnavailableOnlyOwn, ${runId}`);
          if (cursor.definitionsVersion === INDICATOR_DEFINITIONS_VERSION && eventId <= cursor.afterEventId && row === undefined) problems.push(`${label}: CursorCovered, ${runId} at ${eventId} under ${cursor.afterEventId}`);
        }
        return problems;
      };
      return { dbPath, store, clock, timers, session, sessionOf, complete, facts, terminalEvent, invariantProblems };
    };

    const threadOf = (sessionOf: ReadonlyMap<string, string>, poison: ReadonlySet<string>, infraAt: number | undefined, onAsk: (runId: string) => Promise<void> = async () => undefined) => {
      const FactsRefused = factsRefusedError();
      let asked = 0;
      return {
        runFacts: async (runId: string) => {
          asked += 1;
          await onAsk(runId);
          if (asked === infraAt) throw new storeModule.JournalThreadError('journal thread was silent for 1000 ms');
          if (poison.has(runId)) throw new FactsRefused('the fold refused the journal');
          return recordOf(fullRow(runId, sessionOf.get(runId) as string));
        },
      };
    };

    it(`every poison set of ${runCount} runs, an infrastructure failure at each request, and a definitions version change: the invariants hold after every tick and every terminal run gets its row (Coverage)`, async () => {
      const problems: string[] = [];
      const migrated = migratedDatabase();
      for (let mask = 0; mask < 2 ** runCount; mask += 1) {
        for (let infraAt = 0; infraAt <= runCount; infraAt += 1) {
          for (const upgrade of [false, true]) {
            const scene = await world(migrated);
            const ids: string[] = [];
            for (let index = 0; index < runCount; index += 1) ids.push(await scene.complete());
            const poison = new Set(ids.filter((_, index) => (mask & (1 << index)) !== 0));
            const label = `poison ${mask} infra ${infraAt} upgrade ${upgrade}`;
            const sweeper = startFactsSweeper({ store: scene.store as RuntimeStore, thread: threadOf(scene.sessionOf, poison, infraAt === 0 ? undefined : infraAt), timers: scene.timers, intervalMs: 1000, batchSize, onError: () => undefined });
            for (let round = 0; round < runCount * 2 + 2; round += 1) {
              if (upgrade && round === 1) rawDb(scene.dbPath).prepare('UPDATE facts_cursor SET definitions_version = definitions_version - 1').run();
              await tick(scene.timers);
              problems.push(...scene.invariantProblems(poison, `${label} round ${round}`));
            }
            await sweeper.close();
            for (const runId of ids) {
              const row = scene.facts.get(runId);
              if (row === undefined || (row.kind === 'unavailable') !== poison.has(runId)) problems.push(`${label}: Coverage, ${runId} has ${row?.kind ?? 'no row'}`);
            }
          }
        }
      }
      expect(problems).toEqual([]);
    });

    it('a closed session that the retention sweep deletes while its run is in a batch leaves no row behind, and the batch commits with the other runs covered', async () => {
      const periodMs = 100_000;
      const scene = await world(migratedDatabase());
      const closed = await scene.complete();
      scene.clock.advance(periodMs + 1);
      const other = newSession(scene.store).id;
      const kept = await scene.complete(other);
      const thread = threadOf(scene.sessionOf, new Set(), undefined, async (runId) => {
        if (runId === closed) await scene.store.retention.sweep({ periodMs, purges: [] }, new AbortController().signal);
      });
      const errors: unknown[] = [];
      const sweeper = startFactsSweeper({ store: scene.store as RuntimeStore, thread, timers: scene.timers, intervalMs: 1000, batchSize, onError: (error: unknown) => errors.push(error) });
      const problems: string[] = [];
      await tick(scene.timers);
      for (let settle = 0; settle < 8; settle += 1) await afterMicrotasks();
      expect(errors).toEqual([]);
      expect(scene.facts.get(kept)?.kind).toBe('facts');
      for (let round = 0; round < 4; round += 1) {
        await tick(scene.timers);
        for (let settle = 0; settle < 8; settle += 1) await afterMicrotasks();
        problems.push(...scene.invariantProblems(new Set(), `round ${round}`));
      }
      await sweeper.close();
      expect(scene.store.getRun(closed)).toBeUndefined();
      expect(problems).toEqual([]);
      expect(scene.facts.get(kept)?.kind).toBe('facts');
    });
  });
});
