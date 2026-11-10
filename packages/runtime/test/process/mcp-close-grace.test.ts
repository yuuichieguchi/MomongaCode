import { describe, expect, it } from 'vitest';
import type { McpAuthorizingPool, McpPool, McpPoolOptions } from '@momonga/mcp';
import type { Run } from '@momonga/store';
import { createMcpAdmin, createMcpPoolCache } from '@momonga/runtime';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import { POOL_IDLE_CLOSE_MS, START_MS, createSession, flushMicrotasks, makeCache, makeLogger, makeReporter, makeTempHome, openStore, writeUserSettings } from './helpers.ts';

type GracePool = McpAuthorizingPool & { closeGraces: Array<number | undefined> };

const gracePool = (): GracePool => {
  const pool: GracePool = {
    sources: [],
    closeGraces: [],
    diagnostics: () => [],
    close: ((graceMs?: number) => {
      pool.closeGraces.push(graceMs);
      return Promise.resolve();
    }) as McpPool['close'],
    authState: () => Promise.resolve({ state: 'authorized' }),
    authorize: () => Promise.resolve(),
  };
  return pool;
};

const cacheSetup = () => {
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const statuses = new Map<string, Run['status']>();
  const store = { getRun: (id: string): Run | undefined => (statuses.has(id) ? ({ id, status: statuses.get(id) } as Run) : undefined) };
  const notifier = { watchRun: () => () => undefined };
  const reader = { graceMs: 700, reads: 0 };
  const cache = createMcpPoolCache({
    store,
    notifier,
    timers,
    logger: makeLogger(),
    report: makeReporter().report,
    readCloseGraceMs: () => {
      reader.reads += 1;
      return reader.graceMs;
    },
  });
  return { timers, statuses, cache, reader };
};

describe('the MCP pool cache closes each pool with the grace of the close that closes it', () => {
  it('closeAll passes the grace its stop carries to every open pool, and reads nothing', async () => {
    const t = cacheSetup();
    t.statuses.set('r1', 'RUNNING');
    t.statuses.set('r2', 'RUNNING');
    const first = gracePool();
    const second = gracePool();
    t.cache.acquire('r1', { key: 'k1', create: () => first });
    t.cache.acquire('r2', { key: 'k2', create: () => second });
    await flushMicrotasks();
    await t.cache.closeAll(250);
    expect(first.closeGraces).toEqual([250]);
    expect(second.closeGraces).toEqual([250]);
    expect(t.reader.reads).toBe(0);
  });

  it('an idle close outside a stop reads the grace when it begins, not when the pool was created', async () => {
    const t = cacheSetup();
    t.statuses.set('r1', 'RUNNING');
    const pool = gracePool();
    t.cache.acquire('r1', { key: 'k1', create: () => pool });
    await flushMicrotasks();
    t.cache.release('r1');
    t.reader.graceMs = 40;
    t.timers.advance(POOL_IDLE_CLOSE_MS);
    await flushMicrotasks();
    expect(pool.closeGraces).toEqual([40]);
    expect(t.reader.reads).toBe(1);
  });
});

const adminSetup = async () => {
  const temp = await makeTempHome();
  writeUserSettings(temp.home, { mcpServers: { local: { command: 'node', args: ['server.js'] } } });
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const { store } = openStore(temp, clock);
  const session = createSession(store, temp.project);
  const cache = makeCache(temp.home);
  const pools: GracePool[] = [];
  const created: McpPoolOptions[] = [];
  const reader = { graceMs: 900, reads: 0 };
  const admin = createMcpAdmin({
    home: temp.home,
    readConnectTimeoutMs: () => undefined,
    store,
    clock,
    timers,
    logger: makeLogger(),
    report: makeReporter().report,
    settings: {
      envFor: () => ({}),
      admitUserSnapshot: () => {
        const snapshot = cache.snapshot();
        if ('error' in snapshot) throw snapshot.error;
        return { settings: snapshot.settings, user: snapshot.user };
      },
      trustOracle: { isTrusted: () => true },
      keptLayers: (use) => ({ store: cache.kept, use }),
    },
    remote: { openAuthorizationUrl: () => Promise.reject(new Error('not used')) } as never,
    createPool: (options) => {
      created.push(options);
      const pool = gracePool();
      pools.push(pool);
      return pool;
    },
    readCloseGraceMs: () => {
      reader.reads += 1;
      return reader.graceMs;
    },
  });
  return { admin, session, pools, timers, reader };
};

describe('the MCP admin closes its probe pools with the grace of the close that closes them', () => {
  it('close passes the grace its stop carries to every probe pool, and reads nothing', async () => {
    const t = await adminSetup();
    await t.admin.servers(t.session.id, new AbortController().signal);
    await t.admin.close(60);
    expect(t.pools.map((pool) => pool.closeGraces)).toEqual([[60]]);
    expect(t.reader.reads).toBe(0);
  });

  it('an idle probe-pool close reads the grace when it begins', async () => {
    const t = await adminSetup();
    await t.admin.servers(t.session.id, new AbortController().signal);
    t.reader.graceMs = 33;
    t.timers.advance(POOL_IDLE_CLOSE_MS);
    await flushMicrotasks();
    expect(t.pools.map((pool) => pool.closeGraces)).toEqual([[33]]);
    expect(t.reader.reads).toBe(1);
  });
});
