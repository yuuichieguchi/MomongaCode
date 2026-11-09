import { describe, expect, it } from 'vitest';
import { McpAuthorizationError } from '@momonga/mcp';
import type { McpAuthProbe, McpAuthorizingPool, McpPoolOptions } from '@momonga/mcp';
import { createMcpAdmin } from '@momonga/runtime';
import type { McpAdmin } from '@momonga/runtime';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import { POOL_IDLE_CLOSE_MS, START_MS, createSession, makeCache, makeLogger, makeReporter, makeTempHome, openStore, writeUserSettings } from './helpers.ts';

const REMOTE_URL = 'https://mcp.example.test/mcp';
const AUTHORIZE_URL = 'https://auth.example.test/authorize?state=1';

type ProbePlan = { next: McpAuthProbe };

type FakeAuthPool = McpAuthorizingPool & {
  closes: number;
  probes: string[];
  options: McpPoolOptions;
  plan: ProbePlan;
  finishAuthorization(): void;
  failAuthorization(error: unknown): void;
};

const makeAuthPool = (options: McpPoolOptions, plan: ProbePlan): FakeAuthPool => {
  let succeed: () => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const pool: FakeAuthPool = {
    sources: [],
    closes: 0,
    probes: [],
    options,
    plan,
    diagnostics: () => [],
    close: () => {
      pool.closes += 1;
      return Promise.resolve();
    },
    authState: (server) => {
      pool.probes.push(server);
      return Promise.resolve(pool.plan.next);
    },
    authorize: async (_server, signal) => {
      await options.remote?.openAuthorizationUrl(new URL(AUTHORIZE_URL), signal);
      await new Promise<void>((resolve, reject) => {
        succeed = resolve;
        fail = reject;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    finishAuthorization: () => succeed(),
    failAuthorization: (error) => fail(error),
  };
  return pool;
};

const setup = async () => {
  const temp = await makeTempHome();
  writeUserSettings(temp.home, { mcpServers: { local: { command: 'node', args: ['server.js'] }, remote: { type: 'http', url: REMOTE_URL } } });
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const { store } = openStore(temp, clock);
  const session = createSession(store, temp.project);
  const cache = makeCache(temp.home);
  const reporter = makeReporter();
  const pools: FakeAuthPool[] = [];
  const plan: ProbePlan = { next: { state: 'required' } };
  const admin: McpAdmin = createMcpAdmin({
    home: temp.home,
    store,
    clock,
    timers,
    logger: makeLogger(),
    report: reporter.report,
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
    remote: { openAuthorizationUrl: () => Promise.reject(new Error('the admin must supply its own opener')) } as never,
    createPool: (options) => {
      const pool = makeAuthPool(options, plan);
      pools.push(pool);
      return pool;
    },
  });
  return { admin, session, pools, plan, timers, reporter };
};

const controllerSignal = (): AbortSignal => new AbortController().signal;

describe('createMcpAdmin servers', () => {
  it('lists every enabled server with its transport, url and probed auth state', async () => {
    const { admin, session, plan } = await setup();
    plan.next = { state: 'required', detail: 'sign in' };

    const views = await admin.servers(session.id, controllerSignal());

    expect(views).toEqual([
      { name: 'local', scope: 'user', transport: 'stdio', auth: 'required', detail: 'sign in' },
      { name: 'remote', scope: 'user', transport: 'http', url: REMOTE_URL, auth: 'required', detail: 'sign in' },
    ]);
  });

  it('answers an unknown session with not found', async () => {
    const { admin } = await setup();

    await expect(admin.servers('missing', controllerSignal())).rejects.toMatchObject({ status: 404 });
  });

  it('rejects when the request is aborted before a server is probed', async () => {
    const { admin, session, pools } = await setup();
    const aborted = AbortSignal.abort(new Error('client went away'));

    await expect(admin.servers(session.id, aborted)).rejects.toThrow('client went away');
    expect(pools.flatMap((pool) => pool.probes)).toEqual([]);
  });

  it('reuses one pool across requests and probes the live auth state every time', async () => {
    const { admin, session, pools, plan } = await setup();

    plan.next = { state: 'required' };
    const first = await admin.servers(session.id, controllerSignal());
    plan.next = { state: 'authorized' };
    const second = await admin.servers(session.id, controllerSignal());

    expect(pools).toHaveLength(1);
    expect(pools[0]?.probes).toEqual(['local', 'remote', 'local', 'remote']);
    expect(first.map((view) => view.auth)).toEqual(['required', 'required']);
    expect(second.map((view) => view.auth)).toEqual(['authorized', 'authorized']);
    expect(pools[0]?.closes).toBe(0);
  });

  it('closes the pool after it was idle for the pool idle period and builds a new one for the next request', async () => {
    const { admin, session, pools, timers } = await setup();

    await admin.servers(session.id, controllerSignal());
    timers.advance(POOL_IDLE_CLOSE_MS - 1);
    expect(pools[0]?.closes).toBe(0);
    timers.advance(1);
    expect(pools[0]?.closes).toBe(1);

    await admin.servers(session.id, controllerSignal());

    expect(pools).toHaveLength(2);
  });

  it('keeps the pool open while a request is using it and restarts the idle period when it finishes', async () => {
    const { admin, session, pools, timers } = await setup();

    await admin.servers(session.id, controllerSignal());
    timers.advance(POOL_IDLE_CLOSE_MS - 1);
    await admin.servers(session.id, controllerSignal());
    timers.advance(POOL_IDLE_CLOSE_MS - 1);

    expect(pools).toHaveLength(1);
    expect(pools[0]?.closes).toBe(0);
  });

  it('closes its pools on close', async () => {
    const { admin, session, pools } = await setup();
    await admin.servers(session.id, controllerSignal());

    await admin.close();

    expect(pools[0]?.closes).toBe(1);
  });
});

describe('createMcpAdmin authorization', () => {
  it('starts an attempt, returns the url once it is surfaced and reports completion in the server view', async () => {
    const { admin, session, pools } = await setup();

    const started = await admin.startAuthorization(session.id, 'remote');

    expect(started).toMatchObject({ server: 'remote', status: 'awaiting_user', url: AUTHORIZE_URL });
    expect(admin.authorization(session.id, 'remote')).toMatchObject({ status: 'awaiting_user' });
    const authorizing = pools.find((pool) => pool.options.servers.length === 1);
    authorizing?.finishAuthorization();
    await admin.close();
    expect(admin.authorization(session.id, 'remote')).toMatchObject({ status: 'completed', url: AUTHORIZE_URL });
    expect(authorizing?.closes).toBe(1);
  });

  it('returns the running attempt instead of starting a second one', async () => {
    const { admin, session, pools } = await setup();

    const first = await admin.startAuthorization(session.id, 'remote');
    const second = await admin.startAuthorization(session.id, 'remote');

    expect(second).toEqual(first);
    expect(pools).toHaveLength(1);
    await admin.close();
  });

  it('records the typed failure of an attempt that the user denied', async () => {
    const { admin, session, pools } = await setup();
    await admin.startAuthorization(session.id, 'remote');

    pools[0]?.failAuthorization(new McpAuthorizationError('denied', 'the user denied access'));
    await admin.close();

    expect(admin.authorization(session.id, 'remote')).toMatchObject({ status: 'failed', failure: { code: 'denied', message: 'the user denied access' } });
  });

  it('records an untyped failure with the code error', async () => {
    const { admin, session, pools } = await setup();
    await admin.startAuthorization(session.id, 'remote');

    pools[0]?.failAuthorization(new Error('the token endpoint is down'));
    await admin.close();

    expect(admin.authorization(session.id, 'remote')).toMatchObject({ status: 'failed', failure: { code: 'error', message: 'the authorization of MCP server "remote" failed: the token endpoint is down' } });
  });

  it('cancels an awaiting attempt and refuses to cancel anything else', async () => {
    const { admin, session } = await setup();
    expect(admin.cancelAuthorization(session.id, 'remote')).toBe(false);
    await admin.startAuthorization(session.id, 'remote');

    expect(admin.cancelAuthorization(session.id, 'remote')).toBe(true);
    await admin.close();

    expect(admin.authorization(session.id, 'remote')).toMatchObject({ status: 'failed', failure: { code: 'error', message: 'the authorization of MCP server "remote" failed: authorization was cancelled by the client' } });
    expect(admin.cancelAuthorization(session.id, 'remote')).toBe(false);
  });

  it('refuses a stdio server, an unknown server and an unknown session', async () => {
    const { admin, session } = await setup();

    await expect(admin.startAuthorization(session.id, 'local')).rejects.toMatchObject({ status: 400, param: 'name' });
    await expect(admin.startAuthorization(session.id, 'nope')).rejects.toMatchObject({ status: 404 });
    await expect(admin.startAuthorization('missing', 'remote')).rejects.toMatchObject({ status: 404 });
    expect(() => admin.authorization('missing', 'remote')).toThrow('session missing does not exist');
  });

  it('aborts a running attempt on close with the shutdown reason', async () => {
    const { admin, session } = await setup();
    await admin.startAuthorization(session.id, 'remote');

    await admin.close();

    expect(admin.authorization(session.id, 'remote')).toMatchObject({ status: 'failed', failure: { message: 'the authorization of MCP server "remote" failed: the runtime is shutting down' } });
  });
});
