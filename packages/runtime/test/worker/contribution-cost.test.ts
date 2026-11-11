import { describe, expect, it } from 'vitest';
import { openDatabase, BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';
import { contributionAtTerminal } from '@momonga/runtime';
import { createJournalReader } from '@momonga/store';
import type { ContributionPreparer, RuntimeStore } from '@momonga/store';
import { noJournalFacts } from '../../../store/test/helpers.ts';
import { makeEnv } from './harness.ts';
import { MEMORIES, foldedThrough, seedLargeRun } from './large-run.ts';
import { LARGE_RUN_SETUP_TEST_TIMEOUT_MS } from './pause-budget.ts';

const SIZES = [100, 150, 200] as const;

type Counts = { decodedRows: number; decodedBytes: number; encodedBytes: number };

type Path = 'thread' | 'inline';

const threadDouble = (dbPath: () => string): ContributionPreparer => ({
  ...noJournalFacts,
  measure: async (request) => {
    const db = openDatabase(dbPath(), { busyTimeoutMs: BUSY_WAIT_LIMIT_MS });
    try {
      return createJournalReader(db).measure(contributionAtTerminal, request);
    } finally {
      db.close();
    }
  },
});

const inlineControl = (store: () => RuntimeStore): ContributionPreparer => ({
  ...noJournalFacts,
  measure: async (request) => {
    const events = store().readRunEvents(request.runId, 0, 1_000_000);
    const run = store().getRun(request.runId);
    return { lastSeq: run?.lastSeq ?? -1, contribution: { type: 'context.contribution', items: [{ kind: 'memory', id: `events-${events.length}`, contributed: false }] } };
  },
});

const terminalCounts = async (steps: number, path: Path): Promise<Counts> => {
  const counting = { on: false, counts: { decodedRows: 0, decodedBytes: 0, encodedBytes: 0 } };
  let boundStore: RuntimeStore | undefined;
  let boundPath = '';
  const env = await makeEnv({
    mode: 'bypassPermissions',
    preparer: path === 'thread' ? threadDouble(() => boundPath) : inlineControl(() => boundStore as RuntimeStore),
    onDecode: (rows: number, bytes: number) => {
      if (!counting.on) return;
      counting.counts.decodedRows += rows;
      counting.counts.decodedBytes += bytes;
    },
    onEncode: (_kind: string, bytes: number) => {
      if (counting.on) counting.counts.encodedBytes += bytes;
    },
  });
  boundStore = env.store;
  boundPath = env.dbPath;
  const { run, claim } = await seedLargeRun(env, steps);
  const state = foldedThrough(env, run, env.run(run.id).lastSeq);
  expect(env.store.writeSnapshot(claim, state.lastSeq, state).kind).toBe('ok');

  counting.on = true;
  const result = await env.store.transition(claim, ['RUNNING'], 'COMPLETED');
  counting.on = false;

  expect(result.kind).toBe('ok');
  if (path === 'thread') {
    const [contribution] = env.ofType(run.id, 'context.contribution');
    expect(contribution?.items.filter((item) => item.kind === 'memory' && item.contributed).length).toBe(MEMORIES);
  }
  return counting.counts;
};

describe('the loop share of a terminal transition, as counts (P9, design section 7)', () => {
  it('decodes no journal payload on the main thread and encodes the same bytes at 100, 150 and 200 steps, every memory cited at each size, when the journal thread measures', async () => {
    const counts: Counts[] = [];
    for (const steps of SIZES) counts.push(await terminalCounts(steps, 'thread'));

    expect(counts.map((count) => [count.decodedRows, count.decodedBytes])).toEqual(SIZES.map(() => [0, 0]));
    expect(new Set(counts.map((count) => count.encodedBytes)).size).toBe(1);
    expect(counts[0]?.encodedBytes ?? 0).toBeGreaterThan(0);
  }, LARGE_RUN_SETUP_TEST_TIMEOUT_MS);

  it('control: an inline preparer that reads through the store decodes on the main thread, and the count grows with the run', async () => {
    const counts: Counts[] = [];
    for (const steps of SIZES) counts.push(await terminalCounts(steps, 'inline'));

    expect(counts[0]?.decodedRows ?? 0).toBeGreaterThan(0);
    for (let index = 1; index < counts.length; index += 1) {
      expect(counts[index]?.decodedRows ?? 0).toBeGreaterThan(counts[index - 1]?.decodedRows ?? 0);
      expect(counts[index]?.decodedBytes ?? 0).toBeGreaterThan(counts[index - 1]?.decodedBytes ?? 0);
    }
  }, LARGE_RUN_SETUP_TEST_TIMEOUT_MS);
});
