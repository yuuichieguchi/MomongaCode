import { describe, expect, it } from 'vitest';
import type { Run } from '@momonga/store';
import * as runtime from '@momonga/runtime';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import { POOL_IDLE_CLOSE_MS, POOL_REFERENCE_AUDIT_MS, START_MS, flushMicrotasks, makeFakePool, makeLogger, makeReporter } from './helpers.ts';
import type { FakePool } from './helpers.ts';

type Status = Run['status'];

const CLOSE_GRACE_MS = 40;

const setup = () => {
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const logger = makeLogger();
  const reporter = makeReporter();
  const statuses = new Map<string, Status>();
  let getRunError: unknown;
  let reads = 0;
  const store = {
    getRun: (id: string): Run | undefined => {
      reads += 1;
      if (getRunError !== undefined) throw getRunError;
      const status = statuses.get(id);
      return status === undefined ? undefined : ({ id, status } as Run);
    },
  };
  const watchers = new Map<string, Set<() => void>>();
  let unwatches = 0;
  const notifier = {
    watchRun: (runId: string, wake: () => void) => {
      const set = watchers.get(runId) ?? new Set<() => void>();
      set.add(wake);
      watchers.set(runId, set);
      return () => {
        unwatches += 1;
        set.delete(wake);
      };
    },
  };
  const cache = runtime.createMcpPoolCache({ store, notifier, timers, logger, report: reporter.report, readCloseGraceMs: () => CLOSE_GRACE_MS });
  const created: FakePool[] = [];
  const spec = (key: string, pool?: FakePool) => ({
    key,
    create: () => {
      const next = pool ?? makeFakePool();
      created.push(next);
      return next;
    },
  });
  const wake = (runId: string): void => {
    for (const callback of [...(watchers.get(runId) ?? [])]) callback();
  };
  const watcherCount = (): number => [...watchers.values()].reduce((sum, set) => sum + set.size, 0);
  return {
    clock,
    timers,
    logger,
    reporter,
    statuses,
    store,
    cache,
    created,
    spec,
    wake,
    watcherCount,
    unwatches: () => unwatches,
    reads: () => reads,
    failGetRun: (error: unknown) => {
      getRunError = error;
    },
  };
};

describe('MCP pool cache (fake timers)', () => {
  it('acquire is idempotent per run and key and reports changed false', async () => {
    const t = setup();
    t.statuses.set('r1', 'RUNNING');

    const first = t.cache.acquire('r1', t.spec('k1'));
    const second = t.cache.acquire('r1', t.spec('k1'));
    await flushMicrotasks();

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.pool).toBe(first.pool);
    expect(t.created).toHaveLength(1);
    expect(t.cache.size()).toBe(1);
    expect(t.watcherCount()).toBe(1);
  });

  it('a run on another key releases the old reference first', async () => {
    const t = setup();
    t.statuses.set('r1', 'RUNNING');
    const first = t.cache.acquire('r1', t.spec('k1'));

    const second = t.cache.acquire('r1', t.spec('k2'));
    await flushMicrotasks();

    expect(second.changed).toBe(true);
    expect(second.pool).not.toBe(first.pool);
    expect(t.watcherCount()).toBe(1);
    expect(t.cache.size()).toBe(2);
    t.timers.advance(POOL_IDLE_CLOSE_MS);
    await flushMicrotasks();
    expect((first.pool as FakePool).closes).toBe(1);
    expect((second.pool as FakePool).closes).toBe(0);
    expect(t.cache.size()).toBe(1);
  });

  it('concurrent acquires with the same key share one pool', async () => {
    const t = setup();
    t.statuses.set('r1', 'RUNNING');
    t.statuses.set('r2', 'RUNNING');

    const [a, b] = await Promise.all([Promise.resolve().then(() => t.cache.acquire('r1', t.spec('k'))), Promise.resolve().then(() => t.cache.acquire('r2', t.spec('k')))]);

    expect(a.pool).toBe(b.pool);
    expect(a.changed).toBe(true);
    expect(b.changed).toBe(true);
    expect(t.created).toHaveLength(1);
    expect(t.cache.size()).toBe(1);
  });

  it('a terminal event committed before watchRun is caught by the scheduled check', async () => {
    const t = setup();
    t.statuses.set('r1', 'COMPLETED');

    const { pool } = t.cache.acquire('r1', t.spec('k'));
    expect(t.watcherCount()).toBe(1);
    await flushMicrotasks();

    expect(t.cache.release('r1')).toBe(false);
    expect(t.watcherCount()).toBe(0);
    t.timers.advance(POOL_IDLE_CLOSE_MS);
    await flushMicrotasks();
    expect((pool as FakePool).closes).toBe(1);
  });

  it('a run that goes terminal releases its reference', async () => {
    const t = setup();
    t.statuses.set('r1', 'RUNNING');
    const { pool } = t.cache.acquire('r1', t.spec('k'));
    await flushMicrotasks();
    expect(t.watcherCount()).toBe(1);

    t.statuses.set('r1', 'CANCELLED');
    t.wake('r1');
    await flushMicrotasks();

    expect(t.watcherCount()).toBe(0);
    expect(t.cache.release('r1')).toBe(false);
    expect(t.timers.pending().map((timer) => timer.delayMs)).toContain(POOL_IDLE_CLOSE_MS);
    t.timers.advance(POOL_IDLE_CLOSE_MS);
    await flushMicrotasks();
    expect((pool as FakePool).closes).toBe(1);
  });

  it('a run that is WAITING_HUMAN or QUEUED keeps its reference', async () => {
    const t = setup();
    t.statuses.set('r1', 'WAITING_HUMAN');
    t.statuses.set('r2', 'QUEUED');
    t.cache.acquire('r1', t.spec('k'));
    t.cache.acquire('r2', t.spec('k'));
    await flushMicrotasks();
    t.wake('r1');
    t.wake('r2');
    t.timers.advance(POOL_REFERENCE_AUDIT_MS);
    await flushMicrotasks();

    expect(t.watcherCount()).toBe(2);
    expect(t.cache.release('r1')).toBe(true);
    expect(t.cache.release('r2')).toBe(true);
  });

  it('a missing run releases its reference', async () => {
    const t = setup();
    t.cache.acquire('gone', t.spec('k'));
    await flushMicrotasks();

    expect(t.watcherCount()).toBe(0);
    expect(t.cache.release('gone')).toBe(false);
  });

  it('an idle pool closes after 5 minutes', async () => {
    const t = setup();
    t.statuses.set('r1', 'RUNNING');
    const { pool } = t.cache.acquire('r1', t.spec('k'));
    t.cache.release('r1');

    t.timers.advance(POOL_IDLE_CLOSE_MS - 1);
    await flushMicrotasks();
    expect((pool as FakePool).closes).toBe(0);
    expect(t.cache.size()).toBe(1);

    t.timers.advance(1);
    await flushMicrotasks();
    expect((pool as FakePool).closes).toBe(1);
    expect(t.cache.size()).toBe(0);
  });

  it('an acquire during the idle window cancels the idle close', async () => {
    const t = setup();
    t.statuses.set('r1', 'RUNNING');
    t.statuses.set('r2', 'RUNNING');
    const { pool } = t.cache.acquire('r1', t.spec('k'));
    t.cache.release('r1');
    t.timers.advance(POOL_IDLE_CLOSE_MS - 1);

    const again = t.cache.acquire('r2', t.spec('k'));
    t.timers.advance(POOL_IDLE_CLOSE_MS * 2);
    await flushMicrotasks();

    expect(again.pool).toBe(pool);
    expect(t.created).toHaveLength(1);
    expect((pool as FakePool).closes).toBe(0);
    expect(t.cache.size()).toBe(1);
  });

  it('the reference audit releases a terminal run whose notifier event was lost', async () => {
    const t = setup();
    t.statuses.set('r1', 'RUNNING');
    t.cache.acquire('r1', t.spec('k'));
    await flushMicrotasks();
    t.statuses.set('r1', 'FAILED');

    t.timers.advance(POOL_REFERENCE_AUDIT_MS - 1);
    await flushMicrotasks();
    expect(t.watcherCount()).toBe(1);

    t.timers.advance(1);
    await flushMicrotasks();
    expect(t.watcherCount()).toBe(0);
    expect(t.cache.release('r1')).toBe(false);
  });

  it('the audit re-arms while a reference exists', async () => {
    const t = setup();
    t.statuses.set('r1', 'RUNNING');
    t.cache.acquire('r1', t.spec('k'));
    await flushMicrotasks();

    t.timers.advance(POOL_REFERENCE_AUDIT_MS);
    await flushMicrotasks();
    expect(t.timers.pending().filter((timer) => timer.delayMs === POOL_REFERENCE_AUDIT_MS)).toHaveLength(1);

    t.statuses.set('r1', 'STOPPED');
    t.timers.advance(POOL_REFERENCE_AUDIT_MS);
    await flushMicrotasks();
    expect(t.watcherCount()).toBe(0);
  });

  it('the audit timer is cleared when no reference remains', async () => {
    const t = setup();
    t.statuses.set('r1', 'RUNNING');
    t.cache.acquire('r1', t.spec('k'));
    await flushMicrotasks();
    expect(t.timers.pending()).toHaveLength(1);
    expect(t.timers.pending()[0]?.delayMs).toBe(POOL_REFERENCE_AUDIT_MS);

    t.cache.release('r1');

    expect(t.timers.pending().map((timer) => timer.delayMs)).toEqual([POOL_IDLE_CLOSE_MS]);
  });

  it('a check error is routed through report', async () => {
    const t = setup();
    const failure = Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
    t.statuses.set('r1', 'RUNNING');
    t.failGetRun(failure);

    t.cache.acquire('r1', t.spec('k'));
    await flushMicrotasks();

    expect(t.reporter.errors).toEqual([failure]);
    expect(t.watcherCount()).toBe(1);
  });

  it('check is a no-op after closeAll', async () => {
    const t = setup();
    t.statuses.set('r1', 'RUNNING');
    t.cache.acquire('r1', t.spec('k'));
    const before = t.reads();

    await t.cache.closeAll(CLOSE_GRACE_MS);
    t.wake('r1');
    t.timers.advance(POOL_REFERENCE_AUDIT_MS * 2);
    await flushMicrotasks();

    expect(t.reads()).toBe(before);
    expect(t.reporter.errors).toEqual([]);
  });

  it('closeAll awaits an in-flight closeIdle', async () => {
    const t = setup();
    t.statuses.set('r1', 'RUNNING');
    const slow = makeFakePool(undefined, true);
    t.cache.acquire('r1', t.spec('k', slow));
    t.cache.release('r1');
    t.timers.advance(POOL_IDLE_CLOSE_MS);
    await flushMicrotasks();
    expect(slow.closes).toBe(1);
    expect(t.cache.size()).toBe(0);

    let settled = false;
    const closing = t.cache.closeAll(CLOSE_GRACE_MS).then(() => {
      settled = true;
    });
    await flushMicrotasks(50);
    expect(settled).toBe(false);

    slow.finishClose();
    await closing;
    expect(settled).toBe(true);
    expect(slow.closes).toBe(1);
  });

  it('closeAll closes every pool, unwatches every ref and leaves no pending fake timer', async () => {
    const t = setup();
    t.statuses.set('r1', 'RUNNING');
    t.statuses.set('r2', 'RUNNING');
    t.statuses.set('r3', 'RUNNING');
    const a = t.cache.acquire('r1', t.spec('ka')).pool as FakePool;
    const b = t.cache.acquire('r2', t.spec('kb')).pool as FakePool;
    const c = t.cache.acquire('r3', t.spec('kc')).pool as FakePool;
    t.cache.release('r3');
    await flushMicrotasks();
    expect(t.timers.pending().length).toBeGreaterThan(0);

    await t.cache.closeAll(CLOSE_GRACE_MS);

    expect([a.closes, b.closes, c.closes]).toEqual([1, 1, 1]);
    expect(t.watcherCount()).toBe(0);
    expect(t.timers.pending()).toEqual([]);
    expect(t.cache.size()).toBe(0);
  });

  it('closeAll is idempotent', async () => {
    const t = setup();
    t.statuses.set('r1', 'RUNNING');
    const pool = t.cache.acquire('r1', t.spec('k')).pool as FakePool;

    await t.cache.closeAll(CLOSE_GRACE_MS);
    const unwatches = t.unwatches();
    await t.cache.closeAll(CLOSE_GRACE_MS);

    expect(pool.closes).toBe(1);
    expect(t.unwatches()).toBe(unwatches);
    expect(t.timers.pending()).toEqual([]);
  });

  it('acquire after closeAll throws', async () => {
    const t = setup();
    t.statuses.set('r1', 'RUNNING');
    await t.cache.closeAll(CLOSE_GRACE_MS);

    expect(() => t.cache.acquire('r1', t.spec('k'))).toThrow(new Error('the MCP pool cache is closed'));
    expect(t.created).toEqual([]);
  });

  it('release is idempotent, never throws and returns whether a reference was dropped', async () => {
    const t = setup();
    t.statuses.set('r1', 'RUNNING');
    t.cache.acquire('r1', t.spec('k'));

    expect(t.cache.release('never')).toBe(false);
    expect(t.cache.release('r1')).toBe(true);
    expect(t.cache.release('r1')).toBe(false);
    expect(t.unwatches()).toBe(1);
    await t.cache.closeAll(CLOSE_GRACE_MS);
    expect(t.cache.release('r1')).toBe(false);
  });

  it('a pool close failure in closeIdle goes to logger.warn', async () => {
    const t = setup();
    t.statuses.set('r1', 'RUNNING');
    const failing = makeFakePool();
    failing.close = () => Promise.reject(new Error('close exploded'));
    t.cache.acquire('r1', t.spec('k', failing));
    t.cache.release('r1');

    t.timers.advance(POOL_IDLE_CLOSE_MS);
    await flushMicrotasks();

    expect(t.logger.entries.some((entry) => entry.level === 'warn' && entry.msg.includes('close exploded'))).toBe(true);
    expect(t.reporter.errors).toEqual([]);
  });
});
