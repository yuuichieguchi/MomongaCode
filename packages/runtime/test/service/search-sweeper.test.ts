import { describe, expect, it } from 'vitest';
import * as runtime from '@momonga/runtime';
import { HISTORY_INDEX_BATCH_CHARS } from '@momonga/store';
import { afterMicrotasks, createFakeClock, createFakeTimers } from '@momonga/testkit';
import { anchorsOf, harness } from '../../../store/test/helpers.ts';
import { FAKE_KEY, finishedRun, openRun, redactor } from '../../../store/test/search-fixture.ts';
import { START_MS, startService } from './helpers.ts';

type Sweeper = { close(): Promise<void> };

const startSearchSweeper = (options: Record<string, unknown>): Sweeper => {
  const start = (runtime as Record<string, unknown>)['startSearchSweeper'];
  if (typeof start !== 'function') throw new Error('@momonga/runtime does not export startSearchSweeper');
  return start(options) as Sweeper;
};

describe('startSearchSweeper', () => {
  it('bounds each batch by the indexed characters of the runs, not only by their number', async () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const budgets: unknown[] = [];
    const store = { search: { indexBatch: (options: { maxChars?: number }) => (budgets.push(options.maxChars), { runs: 0 }) } };
    const sweeper = startSearchSweeper({ store, timers, intervalMs: 1000, batchSize: 3, redactor, onError: () => undefined });
    timers.advance(1000);
    await afterMicrotasks();
    await sweeper.close();
    expect(budgets).toEqual([HISTORY_INDEX_BATCH_CHARS]);
  });

  it('runs one bounded batch per interval, survives an error and stops on close', async () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const limits: number[] = [];
    const errors: unknown[] = [];
    const failure = new Error('batch failed');
    const store = {
      search: {
        indexBatch: ({ limit }: { limit: number }) => {
          limits.push(limit);
          if (limits.length === 1) throw failure;
          return { runs: 0 };
        },
      },
    };
    const sweeper = startSearchSweeper({ store, timers, intervalMs: 1000, batchSize: 3, redactor, onError: (error: unknown) => errors.push(error) });
    timers.advance(1000);
    await afterMicrotasks();
    timers.advance(1000);
    await afterMicrotasks();
    expect(limits).toEqual([3, 3]);
    expect(errors).toEqual([failure]);
    await sweeper.close();
    timers.advance(5000);
    await afterMicrotasks();
    expect(limits).toEqual([3, 3]);
    expect(timers.pending()).toEqual([]);
  });

  it('drains a backlog over successive ticks through the real store, without indexing a live run', async () => {
    const { store } = harness();
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const done = [await finishedRun(store, '/work/a', 'alphaterm one'), await finishedRun(store, '/work/a', 'alphaterm two'), await finishedRun(store, '/work/a', 'alphaterm three')];
    await openRun(store, '/work/a2', 'alphaterm live');
    const sweeper = startSearchSweeper({ store, timers, intervalMs: 1000, batchSize: 1, redactor, onError: (error: unknown) => { throw error; } });
    const found = () => anchorsOf(store.search.query({ trusted: false, project: '/work/a' }, { query: 'alphaterm', scope: 'project' })).length;
    timers.advance(1000);
    await afterMicrotasks();
    expect(found()).toBe(1);
    timers.advance(1000);
    await afterMicrotasks();
    timers.advance(1000);
    await afterMicrotasks();
    expect(found()).toBe(done.length);
    expect(anchorsOf(store.search.query({ trusted: false, project: '/work/a2' }, { query: 'alphaterm', scope: 'project' }))).toEqual([]);
    await sweeper.close();
  });
});

describe('the service', () => {
  it('indexes terminal runs on its sweep and redacts them', async () => {
    const env = await startService({ fakeTimers: true, sweepIntervalMs: 1000 });
    const session = await env.createSession();
    const run = await env.createRun(session.id, { input: `deploy notes ${FAKE_KEY}` });
    await env.store.requestCancel(run.id);
    env.timers?.advance(1000);
    await afterMicrotasks();
    env.timers?.advance(1000);
    await afterMicrotasks();
    const visibility = { trusted: false, project: session.cwd } as const;
    const anchors = anchorsOf(env.store.search.query(visibility, { query: 'deploy notes', scope: 'project' }));
    expect(anchors.map((anchor) => anchor.runId)).toEqual([run.id]);
    expect(anchorsOf(env.store.search.query(visibility, { query: 'abcdefghij', scope: 'project' }))).toEqual([]);
  });
});
