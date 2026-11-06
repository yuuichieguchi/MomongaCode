import { describe, expect, it } from 'vitest';
import * as runtime from '@momonga/runtime';
import { FACTS_SWEEP_BATCH_RUNS } from '@momonga/protocol';
import type { RunFactsView } from '@momonga/protocol';
import { afterMicrotasks, createFakeClock, createFakeTimers } from '@momonga/testkit';
import { START_MS } from './helpers.ts';

type Sweeper = { close(): Promise<void> };

const startFactsSweeper = (options: Record<string, unknown>): Sweeper => {
  const start = (runtime as Record<string, unknown>)['startFactsSweeper'];
  if (typeof start !== 'function') throw new Error('@momonga/runtime does not export startFactsSweeper');
  return start(options) as Sweeper;
};

type Commit = { rows: readonly RunFactsView[]; unavailable: readonly string[]; throughEventId: number };

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
          return { runIds: ids, throughEventId: afterEventId + ids.length };
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
    const thread = { runFacts: async (runId: string) => (current.push(runId), rowFor(runId)) };
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

  it('records a run whose fold throws as unavailable and passes it, so a later run is not blocked', async () => {
    const timers = createFakeTimers(createFakeClock(START_MS));
    const fake = factsStore(['r1', 'poison', 'r3', 'r4']);
    const errors: unknown[] = [];
    const thread = {
      runFacts: async (runId: string) => {
        if (runId === 'poison') throw new RangeError('the fold of poison threw');
        return rowFor(runId);
      },
    };
    const sweeper = startFactsSweeper({ store: fake.store, thread, timers, intervalMs: 1000, batchSize: 3, onError: (error: unknown) => errors.push(error) });
    await tick(timers);
    await tick(timers);
    await sweeper.close();
    expect(fake.commits[0]).toEqual({ rows: [rowFor('r1'), rowFor('r3')], unavailable: ['poison'], throughEventId: 3 });
    expect(fake.covered().sort()).toEqual(['poison', 'r1', 'r3', 'r4']);
    expect(timers.pending()).toEqual([]);
  });
});
