import { setImmediate as eventLoopTurn } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createRedactor } from '@momonga/foundation';
import { HISTORY_INDEX_BATCH_CHARS } from '@momonga/store';
import { makeEnv } from './harness.ts';
import { OUTPUT_CHARS, seedLargeRun } from './large-run.ts';
import { LARGE_RUN_SETUP_TEST_TIMEOUT_MS } from './pause-budget.ts';

const STEP_SIZES = [20, 80] as const;

type Counts = { rows: number; bytes: number; documents: number; partial: number[] };

const indexingCounts = async (steps: number): Promise<Counts> => {
  const counting = { on: false, rows: 0, bytes: 0 };
  const env = await makeEnv({
    mode: 'bypassPermissions',
    onDecode: (rows, bytes) => {
      if (!counting.on) return;
      counting.rows += rows;
      counting.bytes += bytes;
    },
  });
  const redactor = createRedactor({ credentials: [] });
  const { run, claim } = await seedLargeRun(env, steps);
  expect(await env.store.search.indexBatch({ limit: 10, redactor, maxChars: HISTORY_INDEX_BATCH_CHARS })).toEqual({ runs: 1 });
  expect((await env.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
  const held = (): number => Number(env.raw().prepare('SELECT count(*) AS held FROM search_docs WHERE run_id = ?').get(run.id)?.['held']);
  const seen = new Set<number>();
  let settled = false;

  counting.on = true;
  const indexing = env.store.search.indexBatch({ limit: 10, redactor, maxChars: HISTORY_INDEX_BATCH_CHARS }).finally(() => {
    settled = true;
  });
  while (!settled) {
    seen.add(held());
    await eventLoopTurn();
  }
  await indexing;
  counting.on = false;

  return { rows: counting.rows, bytes: counting.bytes, documents: held(), partial: [...seen].filter((count) => count > 0 && count < steps + 1) };
};

describe('the loop share of search indexing, as counts (row 12, O9; design section 7)', () => {
  it('decodes no event of the run on the loop whether it holds 20 or 80 steps, and gives the loop back between the pages of a run above the budget of one batch', async () => {
    const counts: Counts[] = [];
    for (const steps of STEP_SIZES) counts.push(await indexingCounts(steps));

    expect(counts.map((count) => count.rows)).toEqual(STEP_SIZES.map(() => 0));
    expect(counts.map((count) => count.bytes)).toEqual(STEP_SIZES.map(() => 0));
    expect(counts.map((count) => count.documents)).toEqual(STEP_SIZES.map((steps) => steps + 1));
    expect(STEP_SIZES[1] * OUTPUT_CHARS).toBeGreaterThan(HISTORY_INDEX_BATCH_CHARS);
    expect(counts[1]?.partial.length ?? 0).toBeGreaterThan(0);
  }, LARGE_RUN_SETUP_TEST_TIMEOUT_MS);
});
