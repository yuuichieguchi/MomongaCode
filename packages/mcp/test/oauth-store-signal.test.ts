import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOCK_TIMEOUT_MS, OperationLimitError, StoreCallEndedError, createFileCredentialStore } from '@momonga/foundation';
import type { FileLockPorts } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, startLockHolder } from '@momonga/testkit';
import type { McpOAuthProvider } from '../src/mcp-oauth.ts';
import { createMcpOAuthProvider, credentialKey } from '../src/mcp-oauth.ts';
import type * as RemoteTransportModule from '../src/remote-transport.ts';
import { currentStoreScope } from '../src/store-scope.ts';
import type { StoreScope } from '../src/store-scope.ts';
import { controlledCredentialStore, keyReadLimitSentence, outcomeOf, settledAfter, stillPendingAfter, useLimitTimers } from './credential-store-fakes.ts';
import type { StoreCallRecord } from './credential-store-fakes.ts';
import { makeRemoteConnection, startHttpFixture } from './remote-harness.ts';

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
    clock: { now: () => now },
    sleep: (ms) => {
      now += ms;
      return new Promise((resolve) => setImmediate(resolve));
    },
    randomHex: () => 'cafe0001',
    waitedMs: () => now - start,
  };
};

describe('MCP OAuth provider store waits (N81)', () => {
  it('a record lock wait outlasts the default lock timeout and ends only on the signal of the operation', async (context) => {
    const directory = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-oauth-'))), 'mcp-credentials');
    const url = 'https://mcp.example.com/mcp';
    const store = createFileCredentialStore(directory, { ports: steppedPorts() });
    await store.write(credentialKey('remote', url), '{"version":1,"issuers":{}}', new AbortController().signal);
    const ports = steppedPorts();
    const waiting = createFileCredentialStore(directory, { ports });
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
    for (let turn = 0; turn < 100_000 && ports.waitedMs() <= 3 * DEFAULT_LOCK_TIMEOUT_MS && !settled; turn += 1) await new Promise((resolve) => setImmediate(resolve));
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

describe('the store calls the MCP SDK makes for an operation of a connection', () => {
  afterEach(() => {
    vi.useRealTimers();
    handedToTransport.providers.length = 0;
  });

  const connectedServer = async () => {
    const fixture = await startHttpFixture({ era: 'legacy' });
    const credentials = controlledCredentialStore();
    credentials.observe = (): Observed => {
      const scope = currentStoreScope();
      return { scope, live: scope?.live, inContext: AsyncLocalStorage.snapshot() as InContext };
    };
    const harness = makeRemoteConnection({ fixture, store: credentials.store });
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
    { title: 'listTools', request: (connection: Awaited<ReturnType<typeof connectedServer>>['connection']) => connection.listTools() },
    {
      title: 'releaseCheckpoint',
      request: (connection: Awaited<ReturnType<typeof connectedServer>>['connection']) => connection.releaseCheckpoint({ kind: 'task', taskId: 'task-1', answered: [] }),
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
    expect((requesting.error() as Error).message).toContain(sentence);
  });
});
