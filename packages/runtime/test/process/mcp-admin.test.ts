import { describe, expect, it, vi } from 'vitest';
import { OperationLimitError, StoreCallEndedError } from '@momonga/foundation';
import { KEYCHAIN_BACKEND } from '@momonga/foundation/secret-store';
import { McpAuthorizationError } from '@momonga/mcp';
import type { McpAuthProbe, McpAuthorizingPool, McpPoolOptions } from '@momonga/mcp';
import { createMcpAdmin } from '@momonga/runtime';
import type { McpAdmin } from '@momonga/runtime';
import { createFakeClock, createFakeTimers, unconfiguredDerivedNetworkOf, TEST_STDIO_LAUNCH } from '@momonga/testkit';
import { POOL_IDLE_CLOSE_MS, START_MS, createSession, makeCache, makeLogger, makeReporter, makeTempHome, openStore, writeUserSettings } from './helpers.ts';

const REMOTE_URL = 'https://mcp.example.test/mcp';
const AUTHORIZE_URL = 'https://auth.example.test/authorize?state=1';

type ProbePlan = { next: McpAuthProbe };

type FakeAuthPool = McpAuthorizingPool & {
  closes: number;
  probes: string[];
  probeSignals: Array<AbortSignal | undefined>;
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
    probeSignals: [],
    options,
    plan,
    diagnostics: () => [],
    close: () => {
      pool.closes += 1;
      return Promise.resolve();
    },
    authState: (server, signal) => {
      pool.probes.push(server);
      pool.probeSignals.push(signal);
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

const CLOSE_GRACE_MS = 40;
const ADMIN_CLIENT_VERSION = '0.0.0-admin-test';
const CONNECT_TIMEOUT_MS = 45_000;

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
  const created: McpPoolOptions[] = [];
  const plan: ProbePlan = { next: { state: 'required' } };
  const ended = { count: 0 };
  const admin: McpAdmin = createMcpAdmin({ launch: TEST_STDIO_LAUNCH,
    onAuthorizationEnded: () => {
      ended.count += 1;
    },
    home: temp.home,
    store,
    clock,
    timers,
    logger: makeLogger(),
    report: reporter.report,
    readCloseGraceMs: () => CLOSE_GRACE_MS,
    readConnectTimeoutMs: () => CONNECT_TIMEOUT_MS,
    settings: {
      envFor: async () => ({}),
      admitUserSnapshot: async (signal) => {
        const snapshot = await cache.load(signal);
        if ('error' in snapshot) throw snapshot.error;
        return { settings: snapshot.settings, user: snapshot.user };
      },
      trustOracle: { isTrusted: () => true },
      keptLayers: (use) => ({ store: cache.kept, use }),
    },
    remote: { openAuthorizationUrl: () => Promise.reject(new Error('the admin must supply its own opener')) } as never,
    network: unconfiguredDerivedNetworkOf,
    clientVersion: ADMIN_CLIENT_VERSION,
    createPool: (options) => {
      created.push(options);
      const pool = makeAuthPool(options, plan);
      pools.push(pool);
      return pool;
    },
  });
  return { admin, session, store, project: temp.project, pools, created, plan, timers, reporter, ended };
};

const controllerSignal = (): AbortSignal => new AbortController().signal;

describe('createMcpAdmin servers', () => {
  it('gives every pool it creates the client version it was given', async () => {
    const { admin, session, created } = await setup();

    await admin.servers(session.id, controllerSignal());

    expect(created.length).toBeGreaterThan(0);
    for (const options of created) expect(options.clientVersion).toBe(ADMIN_CLIENT_VERSION);
  });

  it('servers passes the request signal to authState', async () => {
    const { admin, session, pools } = await setup();
    const request = controllerSignal();

    await admin.servers(session.id, request);

    expect(pools.flatMap((pool) => pool.probes)).toEqual(['local', 'remote']);
    const handed = pools.flatMap((pool) => pool.probeSignals);
    expect(handed).toHaveLength(2);
    for (const signal of handed) expect(signal).toBe(request);
  });

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

  it('opens its pools with the connect limit the user set (mcp.connectTimeoutMs)', async () => {
    const { admin, session, pools } = await setup();
    await admin.servers(session.id, controllerSignal());
    expect(pools[0]?.options.connectTimeoutMs).toBe(CONNECT_TIMEOUT_MS);
    await admin.close(CLOSE_GRACE_MS);
  });

  it('closes its pools on close', async () => {
    const { admin, session, pools } = await setup();
    await admin.servers(session.id, controllerSignal());

    await admin.close(CLOSE_GRACE_MS);

    expect(pools[0]?.closes).toBe(1);
  });
});

describe('createMcpAdmin authorization', () => {
  it('starts an attempt, returns the url once it is surfaced and reports completion in the server view', async () => {
    const { admin, session, pools } = await setup();

    const started = await admin.startAuthorization(session.id, 'remote', new AbortController().signal);

    expect(started).toMatchObject({ server: 'remote', status: 'awaiting_user', url: AUTHORIZE_URL });
    expect(admin.authorization(session.id, 'remote')).toMatchObject({ status: 'awaiting_user' });
    const authorizing = pools.find((pool) => pool.options.servers.length === 1);
    authorizing?.finishAuthorization();
    await admin.close(CLOSE_GRACE_MS);
    expect(admin.authorization(session.id, 'remote')).toMatchObject({ status: 'completed', url: AUTHORIZE_URL });
    expect(authorizing?.closes).toBe(1);
  });

  it('returns the running attempt instead of starting a second one', async () => {
    const { admin, session, pools } = await setup();

    const first = await admin.startAuthorization(session.id, 'remote', new AbortController().signal);
    const second = await admin.startAuthorization(session.id, 'remote', new AbortController().signal);

    expect(second).toEqual(first);
    expect(pools).toHaveLength(1);
    await admin.close(CLOSE_GRACE_MS);
  });

  it('records the typed failure of an attempt that the user denied', async () => {
    const { admin, session, pools } = await setup();
    await admin.startAuthorization(session.id, 'remote', new AbortController().signal);

    pools[0]?.failAuthorization(new McpAuthorizationError('denied', 'the user denied access'));
    await admin.close(CLOSE_GRACE_MS);

    expect(admin.authorization(session.id, 'remote')).toMatchObject({ status: 'failed', failure: { code: 'denied', message: 'the user denied access' } });
  });

  it('records an untyped failure with the code error', async () => {
    const { admin, session, pools } = await setup();
    await admin.startAuthorization(session.id, 'remote', new AbortController().signal);

    pools[0]?.failAuthorization(new Error('the token endpoint is down'));
    await admin.close(CLOSE_GRACE_MS);

    expect(admin.authorization(session.id, 'remote')).toMatchObject({ status: 'failed', failure: { code: 'error', message: 'the authorization of MCP server "remote" failed: the token endpoint is down' } });
  });

  it('a sign-in that ended by a store limit has code error and the sentence', async () => {
    const { admin, session, pools } = await setup();
    await admin.startAuthorization(session.id, 'remote', new AbortController().signal);

    pools[0]?.failAuthorization(new StoreCallEndedError({ action: 'read', name: undefined, backend: KEYCHAIN_BACKEND }, new OperationLimitError(30_000, 'the MCP connect limit')));
    await admin.close(CLOSE_GRACE_MS);

    expect(admin.authorization(session.id, 'remote')).toMatchObject({
      status: 'failed',
      failure: {
        code: 'error',
        message:
          'the authorization of MCP server "remote" failed: the read of the key of the stored credentials did not finish within the MCP connect limit of 30000 ms; the Keychain may be waiting for an answer in a window on your screen: answer it or unlock the login keychain',
      },
    });
  });

  it('cancels an awaiting attempt and refuses to cancel anything else', async () => {
    const { admin, session } = await setup();
    expect(admin.cancelAuthorization(session.id, 'remote')).toBe(false);
    await admin.startAuthorization(session.id, 'remote', new AbortController().signal);

    expect(admin.cancelAuthorization(session.id, 'remote')).toBe(true);
    await admin.close(CLOSE_GRACE_MS);

    expect(admin.authorization(session.id, 'remote')).toMatchObject({ status: 'failed', failure: { code: 'error', message: 'the authorization of MCP server "remote" failed: authorization was cancelled by the client' } });
    expect(admin.cancelAuthorization(session.id, 'remote')).toBe(false);
  });

  it('refuses a stdio server, an unknown server and an unknown session', async () => {
    const { admin, session } = await setup();

    await expect(admin.startAuthorization(session.id, 'local', new AbortController().signal)).rejects.toMatchObject({ status: 400, param: 'name' });
    await expect(admin.startAuthorization(session.id, 'nope', new AbortController().signal)).rejects.toMatchObject({ status: 404 });
    await expect(admin.startAuthorization('missing', 'remote', new AbortController().signal)).rejects.toMatchObject({ status: 404 });
    expect(() => admin.authorization('missing', 'remote')).toThrow('session missing does not exist');
  });

  it('aborts a running attempt on close with the shutdown reason', async () => {
    const { admin, session } = await setup();
    await admin.startAuthorization(session.id, 'remote', new AbortController().signal);

    await admin.close(CLOSE_GRACE_MS);

    expect(admin.authorization(session.id, 'remote')).toMatchObject({ status: 'failed', failure: { message: 'the authorization of MCP server "remote" failed: the runtime is shutting down' } });
  });
});

describe('createMcpAdmin counts the authorizations that wait for the person', () => {
  it('counts an attempt from its start until the person answers, and tells its owner when it ends', async () => {
    const { admin, session, pools, ended } = await setup();
    expect(admin.pendingAuthorizations()).toBe(0);

    await admin.startAuthorization(session.id, 'remote', controllerSignal());

    expect(admin.pendingAuthorizations()).toBe(1);
    expect(ended.count).toBe(0);
    pools.at(-1)?.finishAuthorization();
    await vi.waitFor(() => expect(admin.authorization(session.id, 'remote')?.status).toBe('completed'));
    expect(admin.pendingAuthorizations()).toBe(0);
    await vi.waitFor(() => expect(ended.count).toBe(1));
  });

  it('an attempt that fails or is cancelled no longer counts', async () => {
    const { admin, session, pools, ended } = await setup();
    await admin.startAuthorization(session.id, 'remote', controllerSignal());
    pools.at(-1)?.failAuthorization(new McpAuthorizationError('denied', 'the person refused'));
    await vi.waitFor(() => expect(ended.count).toBe(1));
    expect(admin.pendingAuthorizations()).toBe(0);

    await admin.startAuthorization(session.id, 'remote', controllerSignal());
    expect(admin.pendingAuthorizations()).toBe(1);
    expect(admin.cancelAuthorization(session.id, 'remote')).toBe(true);
    await vi.waitFor(() => expect(ended.count).toBe(2));
    expect(admin.pendingAuthorizations()).toBe(0);
  });
});

describe('createMcpAdmin for a folder, with no session', () => {
  const ENV = { PATH: '/usr/bin' };

  it('lists the servers of the folder with their probed state, opens its pool in that folder, and stores nothing', async () => {
    const { admin, store, project, created, plan } = await setup();
    const before = store.listSessions({ limit: 10, cursor: null }).sessions.length;
    plan.next = { state: 'required', detail: 'sign in' };

    const views = await admin.folderServers({ cwd: project, env: ENV }, controllerSignal());

    expect(views).toEqual([
      { name: 'local', scope: 'user', transport: 'stdio', auth: 'required', detail: 'sign in' },
      { name: 'remote', scope: 'user', transport: 'http', url: REMOTE_URL, auth: 'required', detail: 'sign in' },
    ]);
    expect(created.map((options) => options.projectDir)).toEqual([project]);
    expect(store.listSessions({ limit: 10, cursor: null }).sessions).toHaveLength(before);
  });

  it('starts, reads and cancels an authorization by the folder, apart from the attempts of a session of the same folder', async () => {
    const { admin, session, project } = await setup();
    const folder = { cwd: project, env: ENV };
    expect(admin.cancelFolderAuthorization(project, 'remote')).toBe(false);

    const started = await admin.startFolderAuthorization(folder, 'remote', controllerSignal());

    expect(started).toMatchObject({ server: 'remote', status: 'awaiting_user', url: AUTHORIZE_URL });
    expect(admin.folderAuthorization(project, 'remote')).toMatchObject({ status: 'awaiting_user' });
    expect(admin.authorization(session.id, 'remote')).toBeUndefined();
    expect((await admin.folderServers(folder, controllerSignal())).find((view) => view.name === 'remote')?.authorization).toMatchObject({ status: 'awaiting_user' });
    expect(admin.cancelFolderAuthorization(project, 'remote')).toBe(true);
    await admin.close(CLOSE_GRACE_MS);
    expect(admin.folderAuthorization(project, 'remote')).toMatchObject({ status: 'failed' });
  });

  it('refuses a stdio server and an unknown server of the folder', async () => {
    const { admin, project } = await setup();
    const folder = { cwd: project, env: ENV };

    await expect(admin.startFolderAuthorization(folder, 'local', controllerSignal())).rejects.toMatchObject({ status: 400, param: 'name' });
    await expect(admin.startFolderAuthorization(folder, 'nope', controllerSignal())).rejects.toMatchObject({ status: 404 });
  });
});
