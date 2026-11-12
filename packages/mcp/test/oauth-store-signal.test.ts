import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationLimitError, SHUTDOWN_SETTING_LIMITS, StoreCallEndedError, createFileCredentialStore, nodeFileSystem } from '@momonga/foundation';
import { DEFAULT_LOCK_TIMEOUT_MS } from '../../foundation/src/file-lock.ts';
import type { FileLockPorts } from '@momonga/foundation';
import { McpInputSuspension, MIN_TASK_POLL_MS, createManagedConnection } from '@momonga/mcp';
import { afterMicrotasks, createFakeClock, createFakeRandom, createTempDir, REAL_PROCESS_TEST_TIMEOUT_MS, sleepDrivenTiming, startLockHolder, TEST_STDIO_LAUNCH, testKernelLock, waitFor } from '@momonga/testkit';
import type { McpOAuthProvider } from '../src/mcp-oauth.ts';
import { createMcpOAuthProvider, credentialKey } from '../src/mcp-oauth.ts';
import type * as RemoteTransportModule from '../src/remote-transport.ts';
import { currentStoreScope } from '../src/store-scope.ts';
import type { StoreScope } from '../src/store-scope.ts';
import { KEYCHAIN_UNANSWERED_ADVICE, limitArmed, controlledCredentialStore, keyReadLimitSentence, outcomeOf, settledAfter, stillPendingAfter, useLimitTimers } from './credential-store-fakes.ts';
import type { ControlledCredentialStore, Outcome, StoreCallRecord } from './credential-store-fakes.ts';
import { BASE_ENV, NEVER_ABORTED, makeDir, onCleanup } from './mcp-harness.ts';
import { browserThatFollowsRedirect, makeRemoteConnection, observedTimers, startHttpFixture, startOauthFixture } from './remote-harness.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const handedToTransport = vi.hoisted(() => ({ providers: [] as unknown[] }));

vi.mock('../src/remote-transport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteTransportModule>();
  return {
    ...actual,
    createRemoteTransport: (options: Parameters<typeof actual.createRemoteTransport>[0]) => {
      if (options.authProvider !== undefined) handedToTransport.providers.push(options.authProvider);
      return actual.createRemoteTransport(options);
    },
  };
});

const steppedPorts = (): FileLockPorts & { waitedMs(): number } => {
  const start = 1_000_000;
  let now = start;
  return {
    timing: sleepDrivenTiming({
      now: () => now,
      sleep: (ms) => {
        now += ms;
        return afterMicrotasks();
      },
    }),
    random: { ...createFakeRandom(1), hex: () => 'cafe0001' },
    waitedMs: () => now - start,
  };
};

describe('MCP OAuth provider store waits (N81)', () => {
  it('a record lock wait outlasts the default lock timeout and ends only on the signal of the operation', async (context) => {
    const directory = path.join(createTempDir(), 'mcp-credentials');
    const url = 'https://mcp.example.com/mcp';
    const store = createFileCredentialStore(directory, { lock: testKernelLock(), ports: steppedPorts() });
    await store.write(credentialKey('remote', url), '{"version":1,"issuers":{}}', new AbortController().signal);
    const ports = steppedPorts();
    const waiting = createFileCredentialStore(directory, { lock: testKernelLock(), ports });
    const lockDirectory = `${directory}.locks`;
    const [lockName] = fs.readdirSync(lockDirectory);
    await startLockHolder(context, path.join(lockDirectory, lockName as string));
    const controller = new AbortController();
    const provider = createMcpOAuthProvider({
      server: 'remote',
      resourceUrl: url,
      scope: 'user',
      store: waiting,
      signalForCall: () => controller.signal,
      redirectUrl: 'http://127.0.0.1:1/callback',
      randomToken: () => 'state',
      onAuthorizationUrl: () => undefined,
    });
    let settled = false;
    const attempt = Promise.resolve(provider.invalidateCredentials?.('tokens')).finally(() => {
      settled = true;
    });
    attempt.catch(() => undefined);
    await waitFor(() => ports.waitedMs() > 3 * DEFAULT_LOCK_TIMEOUT_MS || settled, { description: 'the writer to wait past three lock timeouts or to end' });
    expect(settled).toBe(false);
    expect(ports.waitedMs()).toBeGreaterThan(3 * DEFAULT_LOCK_TIMEOUT_MS);
    const reason = new Error('the authorization was cancelled');
    controller.abort(reason);
    await expect(attempt).rejects.toBe(reason);
  });
});

type InContext = <T>(task: () => T) => T;

type Observed = { scope: StoreScope | undefined; live: boolean | undefined; inContext: InContext };

const observedAt = (call: StoreCallRecord | undefined): Observed => (call as StoreCallRecord).observed as Observed;

const observeScopes = (credentials: ControlledCredentialStore): void => {
  credentials.observe = (): Observed => {
    const scope = currentStoreScope();
    return { scope, live: scope?.live, inContext: AsyncLocalStorage.snapshot() as InContext };
  };
};

const answersBeforeTheClose = (credentials: ControlledCredentialStore): void => {
  onCleanup(() => {
    credentials.mode = 'answer';
  });
};

const STORE_READS_OF_A_CONNECT = 4;
const READS_A_CONNECT_WAITS_FOR = 3;
const FAKE_MS_BEFORE_THE_OPERATION_ENDS = 10_000;
const CONNECT_LIMIT_MS = 30_000;
const REQUEST_LIMIT_MS = 60_000;
const TASK_CALL_TIMEOUT_MS = 1_000_000;

const onlyHungRead = (credentials: ControlledCredentialStore): StoreCallRecord => {
  const hung = credentials.calls.filter((call) => call.mode === 'hang');
  expect(hung).toHaveLength(1);
  return hung[0] as StoreCallRecord;
};

const expectEndedAtTheConnectLimit = (read: StoreCallRecord): void => {
  const ended = read.rejection as StoreCallEndedError;
  expect(ended).toBeInstanceOf(StoreCallEndedError);
  expect(ended.message).toBe(keyReadLimitSentence('the MCP connect limit', CONNECT_LIMIT_MS));
  expect(ended.limit).toBeInstanceOf(OperationLimitError);
  expect(ended.limit.label).toBe('the MCP connect limit');
  expect(ended.limit.limitMs).toBe(CONNECT_LIMIT_MS);
  expect(ended.cause).toBe(ended.limit);
  expect(read.signal.reason).toBe(ended.limit);
};

const SERVER_THAT_NEVER_ANSWERS_A_LISTING = [
  "require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {",
  '  const request = JSON.parse(line);',
  "  if (request.id === undefined || request.method === 'tools/list') return;",
  "  const answer = request.method === 'initialize'",
  "    ? { result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'silent-listing', version: '1.0.0' } } }",
  "    : { error: { code: -32601, message: 'Method not found' } };",
  "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...answer }) + '\\n');",
  '});',
].join('\n');

describe('the store calls the MCP SDK makes for an operation of a connection', () => {
  afterEach(() => {
    vi.useRealTimers();
    handedToTransport.providers.length = 0;
  });

  const connectedServer = async () => {
    const fixture = await startHttpFixture({ era: 'legacy' });
    const credentials = controlledCredentialStore();
    observeScopes(credentials);
    const harness = makeRemoteConnection({ fixture, store: credentials.store });
    answersBeforeTheClose(credentials);
    await harness.connection.connect();
    await harness.connection.listTools({ signal: new AbortController().signal });
    const duringConnect = credentials.calls[0];
    const answered = credentials.calls.length;
    credentials.mode = 'hang';
    return { fixture, credentials, duringConnect, hungRead: (index: number): StoreCallRecord => credentials.calls[answered + index] as StoreCallRecord, ...harness };
  };

  it("a tool call's store read ends with the call's own signal", async () => {
    const server = await connectedServer();
    const call = new AbortController();
    const reason = new Error('the call was stopped');

    const calling = outcomeOf(server.connection.callTool({ name: 'echo', arguments: { text: 'x' }, signal: call.signal }));
    await server.credentials.arrived(1, 'hang');
    const read = server.hungRead(0);
    expect(observedAt(read).scope).toBeDefined();
    expect(observedAt(read).live).toBe(true);
    expect(read.signal.aborted).toBe(false);
    call.abort(reason);
    await settledAfter(calling);

    expect(read.rejection).toBe(reason);
    expect(calling.state()).toBe('rejected');
  });

  it('concurrent tool calls have their own scope', async () => {
    const server = await connectedServer();
    const first = new AbortController();
    const second = new AbortController();
    const firstReason = new Error('the first call was stopped');
    const secondReason = new Error('the second call was stopped');

    const firstCall = outcomeOf(server.connection.callTool({ name: 'echo', arguments: { text: 'a' }, signal: first.signal }));
    await server.credentials.arrived(1, 'hang');
    const secondCall = outcomeOf(server.connection.callTool({ name: 'echo', arguments: { text: 'b' }, signal: second.signal }));
    await server.credentials.arrived(2, 'hang');
    const firstRead = server.hungRead(0);
    const secondRead = server.hungRead(1);
    expect(observedAt(firstRead).scope).toBeDefined();
    expect(observedAt(secondRead).scope).toBeDefined();
    expect(observedAt(secondRead).scope).not.toBe(observedAt(firstRead).scope);
    first.abort(firstReason);
    await settledAfter(firstCall);

    expect(firstRead.rejection).toBe(firstReason);
    expect(secondRead.signal.aborted).toBe(false);
    expect(secondRead.rejection).toBeUndefined();
    expect(secondCall.state()).toBe('pending');
    second.abort(secondReason);
    await settledAfter(secondCall);
    expect(secondRead.rejection).toBe(secondReason);
  });

  it.for([{ title: 'in the scope of the connect that has ended', insideEndedConnect: true }, { title: 'outside every scope', insideEndedConnect: false }])(
    'a token read with no live scope gets a fresh connect limit ($title)',
    async ({ insideEndedConnect }) => {
      const server = await connectedServer();
      const provider = handedToTransport.providers.at(-1) as McpOAuthProvider;
      const connectScope = observedAt(server.duringConnect).scope;
      expect(connectScope).toBeDefined();
      expect(observedAt(server.duringConnect).live).toBe(true);
      expect(connectScope?.live).toBe(false);
      const startRead = (): Promise<unknown> => Promise.resolve(provider.tokens());
      useLimitTimers();

      const reading = outcomeOf(insideEndedConnect ? observedAt(server.duringConnect).inContext(startRead) : startRead());
      await server.credentials.arrived(1, 'hang');
      const read = server.hungRead(0);
      expect(observedAt(read).scope).toBe(insideEndedConnect ? connectScope : undefined);
      expect(read.signal).not.toBe(connectScope?.signal);
      await stillPendingAfter(reading, 29_999);
      await vi.advanceTimersByTimeAsync(1);
      await settledAfter(reading);

      expect(reading.state()).toBe('rejected');
      expect(reading.error()).toBeInstanceOf(StoreCallEndedError);
      expect((reading.error() as Error).message).toBe(keyReadLimitSentence('the MCP connect limit', 30_000));
      expect(read.signal.reason).toBeInstanceOf(OperationLimitError);
    },
  );

  it.for([
    { title: 'listTools', request: (connection: Awaited<ReturnType<typeof connectedServer>>['connection']): Promise<unknown> => connection.listTools() },
    {
      title: 'releaseCheckpoint',
      request: (connection: Awaited<ReturnType<typeof connectedServer>>['connection']): Promise<unknown> => connection.releaseCheckpoint({ kind: 'task', taskId: 'task-1', answered: [] }),
    },
  ])('listTools and releaseCheckpoint have the request limit ($title)', async ({ request }) => {
    const server = await connectedServer();
    useLimitTimers();

    const requesting = outcomeOf(request(server.connection));
    await server.credentials.arrived(1, 'hang');
    await stillPendingAfter(requesting, 59_999);
    await vi.advanceTimersByTimeAsync(1);
    await settledAfter(requesting);

    const sentence = keyReadLimitSentence('the MCP request limit', 60_000);
    expect(requesting.state()).toBe('rejected');
    expect(server.hungRead(0).rejection).toBeInstanceOf(StoreCallEndedError);
    expect((server.hungRead(0).rejection as Error).message).toBe(sentence);
    expect((requesting.error() as Error).message).toBe(sentence);
  });

  it('listTools has the request limit when the request hangs outside the store', async () => {
    const connection = createManagedConnection({ launch: TEST_STDIO_LAUNCH, files: nodeFileSystem,
      clientVersion: '0.0.0-test',
      name: 's',
      config: { command: process.execPath, args: ['-e', SERVER_THAT_NEVER_ANSWERS_A_LISTING] },
      scope: 'user',
      projectDir: makeDir(),
      baseEnv: BASE_ENV,
      clock: createFakeClock(1_000_000),
      random: () => 0,
    });
    onCleanup(() => connection.close());
    await connection.connect();
    useLimitTimers();

    const requesting = outcomeOf(connection.listTools());
    await limitArmed();
    await stillPendingAfter(requesting, REQUEST_LIMIT_MS - 1);
    await vi.advanceTimersByTimeAsync(1);
    await settledAfter(requesting);

    expect(requesting.state()).toBe('rejected');
    expect((requesting.error() as Error).message).toBe('the request did not finish within the MCP request limit of 60000 ms');
  });

  it('releaseCheckpoint has the request limit when the request hangs outside the store', async () => {
    const fixture = await startHttpFixture({ era: 'modern', taskPollIntervalMs: 1, holdFirstTaskCancel: true });
    const timers = observedTimers(createFakeClock(1_000_000));
    const { connection } = makeRemoteConnection({ fixture, timers });
    await connection.listTools();
    const pollScheduled = timers.nextScheduled((ms) => ms !== TASK_CALL_TIMEOUT_MS);
    const suspended = outcomeOf(connection.callTool({ name: 'ask_task', arguments: {}, signal: NEVER_ABORTED, timeoutMs: TASK_CALL_TIMEOUT_MS }));
    await pollScheduled;
    timers.advance(MIN_TASK_POLL_MS);
    await settledAfter(suspended);
    const { checkpoint } = suspended.error() as McpInputSuspension;
    expect(checkpoint.kind).toBe('task');

    const requesting = outcomeOf(connection.releaseCheckpoint(checkpoint));
    await fixture.until(() => fixture.notes.some((note) => note.type === 'task_cancel_held'));
    timers.advance(REQUEST_LIMIT_MS - 1);
    expect(timers.nextDueAt()).toBe(timers.monotonicMs() + 1);
    expect(requesting.state()).toBe('pending');
    timers.advance(1);
    await settledAfter(requesting);

    expect(requesting.state()).toBe('rejected');
    expect((requesting.error() as Error).message).toBe('the request did not finish within the MCP request limit of 60000 ms');
  });

  it('a store read still pending when the connect ends ends at a connect limit', async () => {
    const fixture = await startHttpFixture({ era: 'legacy' });
    const credentials = controlledCredentialStore();
    observeScopes(credentials);
    credentials.mode = () => (credentials.calls.length === READS_A_CONNECT_WAITS_FOR ? 'hang' : 'answer');
    let connectTookItsTime = false;
    credentials.beforeAnswer = async () => {
      if (connectTookItsTime) return;
      connectTookItsTime = true;
      await vi.advanceTimersByTimeAsync(FAKE_MS_BEFORE_THE_OPERATION_ENDS);
    };
    const { connection } = makeRemoteConnection({ fixture, store: credentials.store });
    useLimitTimers();

    await connection.connect();
    await credentials.arrived(1, 'hang');
    const read = onlyHungRead(credentials);
    expect(credentials.calls).toHaveLength(STORE_READS_OF_A_CONNECT);
    expect(observedAt(read).scope).toBeDefined();
    expect(observedAt(read).scope).toBe(observedAt(credentials.calls[0]).scope);
    expect(observedAt(read).scope?.live).toBe(false);
    await vi.advanceTimersByTimeAsync(CONNECT_LIMIT_MS - 1);
    expect(read.signal.aborted).toBe(false);
    expect(read.rejection).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await read.left;

    expectEndedAtTheConnectLimit(read);
  });

  it('a store read still pending when a tool call ends ends at a connect limit', async () => {
    const server = await connectedServer();
    const provider = handedToTransport.providers.at(-1) as McpOAuthProvider;
    server.credentials.mode = 'answer';
    let reading: Outcome<unknown> | undefined;
    server.credentials.beforeAnswer = async () => {
      if (reading !== undefined) return;
      server.credentials.mode = 'hang';
      reading = outcomeOf(Promise.resolve(provider.tokens()));
      await server.credentials.arrived(1, 'hang');
      server.credentials.mode = 'answer';
      await vi.advanceTimersByTimeAsync(FAKE_MS_BEFORE_THE_OPERATION_ENDS);
    };
    useLimitTimers();

    await server.connection.callTool({ name: 'echo', arguments: { text: 'x' }, signal: NEVER_ABORTED });
    const read = onlyHungRead(server.credentials);
    const started = reading as Outcome<unknown>;
    expect(observedAt(read).scope).toBeDefined();
    expect(observedAt(read).live).toBe(true);
    expect(observedAt(read).scope?.live).toBe(false);
    await stillPendingAfter(started, CONNECT_LIMIT_MS - 1);
    expect(read.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settledAfter(started);

    expectEndedAtTheConnectLimit(read);
    expect(started.state()).toBe('rejected');
    expect(started.error()).toBeInstanceOf(StoreCallEndedError);
    expect((started.error() as Error).message).toBe(keyReadLimitSentence('the MCP connect limit', CONNECT_LIMIT_MS));
  });

  const connectedWithoutAListing = async () => {
    const fixture = await startHttpFixture({ era: 'legacy' });
    const credentials = controlledCredentialStore();
    const harness = makeRemoteConnection({ fixture, store: credentials.store });
    answersBeforeTheClose(credentials);
    await harness.connection.connect();
    await credentials.arrived(STORE_READS_OF_A_CONNECT);
    credentials.mode = 'hang';
    return { fixture, credentials, ...harness };
  };

  it("a tool call's first listing has the request limit (the call fails at requestTimeoutMs)", async () => {
    const server = await connectedWithoutAListing();
    useLimitTimers();

    const calling = outcomeOf(server.connection.callTool({ name: 'echo', arguments: { text: 'x' }, signal: NEVER_ABORTED }));
    await server.credentials.arrived(1, 'hang');
    const read = onlyHungRead(server.credentials);
    await stillPendingAfter(calling, REQUEST_LIMIT_MS - 1);
    await vi.advanceTimersByTimeAsync(1);
    await settledAfter(calling);

    const sentence = keyReadLimitSentence('the MCP request limit', REQUEST_LIMIT_MS);
    expect(calling.state()).toBe('rejected');
    expect((calling.error() as Error).message).toBe(sentence);
    expect(read.rejection).toBeInstanceOf(StoreCallEndedError);
    expect((read.rejection as Error).message).toBe(sentence);
    expect(server.fixture.rpcRecords('tools/list')).toEqual([]);
    expect(server.fixture.rpcRecords('tools/call')).toEqual([]);
  });

  it("a tool call's first listing has the request limit (the call's signal ends the read first)", async () => {
    const server = await connectedWithoutAListing();
    const call = new AbortController();
    const reason = new Error('the call was stopped');

    const calling = outcomeOf(server.connection.callTool({ name: 'echo', arguments: { text: 'x' }, signal: call.signal }));
    await server.credentials.arrived(1, 'hang');
    const read = onlyHungRead(server.credentials);
    expect(read.signal.aborted).toBe(false);
    call.abort(reason);
    await settledAfter(calling);

    expect(read.rejection).toBe(reason);
    expect(calling.state()).toBe('rejected');
    expect(server.fixture.rpcRecords('tools/call')).toEqual([]);
  });
});

describe('a signed-in connection against its store after an operation was stopped', () => {
  const signedInServer = async (connection: { closeGraceMs?: number } = {}, closeInCleanup = false) => {
    const oauth = await startOauthFixture();
    const fixture = await startHttpFixture({ era: 'legacy', oauth });
    const credentials = controlledCredentialStore();
    const timers = observedTimers(createFakeClock(1_000_000));
    const follow = browserThatFollowsRedirect();
    const harness = makeRemoteConnection({ fixture, store: credentials.store, timers, openAuthorizationUrl: async (url) => follow(url), connection: { name: 's', ...connection }, closeInCleanup });
    await harness.connection.authorize(new AbortController().signal);
    await harness.connection.listTools();
    const sessionDeletes = () => fixture.records.filter((record) => record.httpMethod === 'DELETE');
    return { oauth, fixture, credentials, timers, sessionDeletes, ...harness };
  };

  it.for([
    { title: 'the default of the setting', closeGraceMs: undefined, graceMs: SHUTDOWN_SETTING_LIMITS.mcpCloseGraceMs.default },
    { title: 'a configured 500 ms', closeGraceMs: 500, graceMs: 500 },
  ])('close with a store that hangs ends at the close grace and names the store call ($title)', async ({ closeGraceMs, graceMs }) => {
    const server = await signedInServer(closeGraceMs === undefined ? {} : { closeGraceMs });
    const answered = server.credentials.calls.length;
    server.credentials.mode = 'hang';

    const closing = outcomeOf(server.connection.close());
    await server.credentials.arrived(1, 'hang');
    server.timers.advance(graceMs - 1);
    expect(server.timers.nextDueAt()).toBe(server.timers.monotonicMs() + 1);
    expect(closing.state()).toBe('pending');
    server.timers.advance(1);
    await settledAfter(closing);

    const read = server.credentials.calls[answered] as StoreCallRecord;
    const failure = closing.error() as Error;
    expect(closing.state()).toBe('rejected');
    expect(failure.message).toBe(
      `MCP server "s" did not end its session within ${graceMs}ms: the read of the key of the stored credentials did not finish within the MCP close limit of ${graceMs} ms; ${KEYCHAIN_UNANSWERED_ADVICE}`,
    );
    expect(failure.cause).toBeInstanceOf(StoreCallEndedError);
    expect(read.rejection).toBeInstanceOf(StoreCallEndedError);
    expect((failure.cause as StoreCallEndedError).limit.label).toBe('the MCP close limit');
    expect((failure.cause as StoreCallEndedError).limit.limitMs).toBe(graceMs);
    expect(server.sessionDeletes()).toEqual([]);
    await settledAfter(outcomeOf(server.connection.close()));
  });

  it("close sends the session's DELETE with the token of a signed-in server", async () => {
    const server = await signedInServer();
    const sessionId = server.fixture.rpcRecords('tools/list').at(-1)?.headers['mcp-session-id'] as string;
    expect(sessionId).toEqual(expect.any(String));

    await server.connection.close();

    const deletes = server.sessionDeletes();
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.headers['authorization']).toBe(`Bearer ${server.oauth.issuedAccessTokens()[0]}`);
    expect(deletes[0]?.headers['mcp-session-id']).toBe(sessionId);
    expect(server.fixture.notes.filter((note) => note.type === 'session_deleted')).toEqual([{ type: 'session_deleted', sessionId }]);
  });

  it('an aborted tool call still sends its cancellation with the token', async () => {
    const server = await signedInServer({}, true);
    const call = new AbortController();
    const slowCalls = () => server.fixture.rpcRecords('tools/call').filter((record) => record.rpc?.params['name'] === 'slow');

    const calling = outcomeOf(server.connection.callTool({ name: 'slow', arguments: {}, signal: call.signal }));
    await server.fixture.until(() => slowCalls().length === 1);
    call.abort(new Error('the call was stopped'));
    await settledAfter(calling);
    await server.fixture.until(() => server.fixture.rpcRecords('notifications/cancelled').length === 1);

    const [cancellation] = server.fixture.rpcRecords('notifications/cancelled');
    expect(calling.state()).toBe('rejected');
    expect(cancellation?.rpc?.params['requestId']).toBe(slowCalls()[0]?.rpc?.id);
    expect(cancellation?.headers['authorization']).toBe(`Bearer ${server.oauth.issuedAccessTokens()[0]}`);
    expect(server.fixture.notes.filter((note) => note.type === 'cancelled')).toEqual([{ type: 'cancelled', requestId: slowCalls()[0]?.rpc?.id }]);
  });
});
