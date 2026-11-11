import net from 'node:net';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { CredentialStoreError, nodeFileSystem } from '@momonga/foundation';
import { McpUnavailableError, McpUnknownToolError, connectMcpServer, createManagedConnection, type McpServerConnection } from '@momonga/mcp';
import type { McpCallToolInput } from '../src/connection.ts';
import { LIMIT_TEST, NO_STORE_REFUSAL, limitArmed, controlledCredentialStore, keyReadLimitSentence, outcomeOf, settledAfter, stillPendingAfter, useLimitTimers } from './credential-store-fakes.ts';
import { makeRemoteConnection, startHttpFixture } from './remote-harness.ts';
import type { McpServerConfig } from '@momonga/config';
import {
  LEGACY_FIXTURE_PROTOCOL_VERSION,
  LEGACY_FIXTURE_TOOL_NAMES,
  MODERN_FIXTURE_LIST_TTL_ENV,
  MODERN_FIXTURE_PROTOCOL_VERSION,
  MODERN_FIXTURE_TOOL_NAMES,
  createFakeClock,
} from '@momonga/testkit';
import {
  BASE_ENV,
  NEVER_ABORTED,
  callRecords,
  groupExists,
  legacyConfig,
  listRecordCount,
  makeDir,
  makeRecordFile,
  modernConfig,
  onCleanup,
  readRecords,
  waitForRecord,
} from './mcp-harness.ts';

const connect = async (name: string, config: McpServerConfig, requestTimeoutMs?: number): Promise<McpServerConnection> => {
  const connection = await connectMcpServer({ files: nodeFileSystem,
    clientVersion: '0.0.0-test',
    name,
    config,
    scope: 'user',
    projectDir: makeDir(),
    baseEnv: BASE_ENV,
    clock: createFakeClock(1_000_000),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  });
  onCleanup(() => connection.close());
  return connection;
};

const textOf = (result: { content?: unknown }): string =>
  (result.content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

describe('connectMcpServer negotiation', () => {
  it('negotiates 2026-07-28 in the modern era with the modern fixture', async () => {
    const connection = await connect('modern', modernConfig(makeRecordFile()));
    expect(connection.protocolVersion).toBe(MODERN_FIXTURE_PROTOCOL_VERSION);
    expect(connection.protocolVersion).toBe('2026-07-28');
    expect(connection.protocolEra).toBe('modern');
    expect(connection.serverInfo).toEqual({ name: 'momonga-modern-fixture', version: '1.0.0' });
    expect(connection.instructions).toBe('Modern fixture server');
  });

  it('negotiates 2025-11-25 in the legacy era with the hand-written legacy fixture', async () => {
    const connection = await connect('legacy', legacyConfig());
    expect(connection.protocolVersion).toBe(LEGACY_FIXTURE_PROTOCOL_VERSION);
    expect(connection.protocolVersion).toBe('2025-11-25');
    expect(connection.protocolEra).toBe('legacy');
    expect(connection.serverInfo).toEqual({ name: 'momonga-legacy-fixture', version: '1.0.0' });
  });

  it('reports a connected state with the process group, version and no error', async () => {
    const connection = await connect('modern', modernConfig(makeRecordFile()));
    const diagnostics = connection.diagnostics();
    expect(diagnostics).toMatchObject({ server: 'modern', state: 'connected', protocolVersion: '2026-07-28', lastError: null });
    expect(typeof diagnostics.pgid).toBe('number');
    expect(await groupExists(diagnostics.pgid as number)).toBe(true);
  });

  it('closes and reaps the server process group', async () => {
    const connection = await connect('modern', modernConfig(makeRecordFile()));
    const pgid = connection.diagnostics().pgid as number;
    await connection.close();
    expect(await groupExists(pgid)).toBe(false);
    expect(connection.diagnostics().state).toBe('closed');
  });
});

describe('connectMcpServer remote configs', () => {
  it('refuses a remote config that has no credential store and opens no connection', async () => {
    let connections = 0;
    const server = net.createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    onCleanup(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as net.AddressInfo;
    await expect(
      connectMcpServer({ files: nodeFileSystem,
        clientVersion: '0.0.0-test',
        name: 'remote',
        config: { type: 'http', url: `http://127.0.0.1:${port}/mcp` },
        scope: 'user',
        projectDir: makeDir(),
        baseEnv: BASE_ENV,
        clock: createFakeClock(0),
      }),
    ).rejects.toThrow(/no credential store/i);
    expect(connections).toBe(0);
  });
});

describe('connectMcpServer tool listing', () => {
  it('follows every pagination cursor of the modern fixture', async () => {
    const recordFile = makeRecordFile();
    const connection = await connect('modern', modernConfig(recordFile));
    const tools = await connection.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...MODERN_FIXTURE_TOOL_NAMES]);
    const cursors = readRecords(recordFile).flatMap((record) => (record.type === 'list' ? [record.cursor] : []));
    expect(cursors).toEqual([null, '6', '12']);
  });

  it('lists the legacy fixture tools', async () => {
    const connection = await connect('legacy', legacyConfig());
    expect((await connection.listTools()).map((tool) => tool.name)).toEqual([...LEGACY_FIXTURE_TOOL_NAMES]);
  });

  it('serves a re-list from the SDK cache while the server ttlMs is fresh', async () => {
    const recordFile = makeRecordFile();
    const connection = await connect('modern', modernConfig(recordFile, { [MODERN_FIXTURE_LIST_TTL_ENV]: '600000' }));
    await connection.listTools();
    const afterFirst = listRecordCount(recordFile);
    expect(afterFirst).toBe(3);
    const second = await connection.listTools();
    expect(second.map((tool) => tool.name)).toEqual([...MODERN_FIXTURE_TOOL_NAMES]);
    expect(listRecordCount(recordFile)).toBe(afterFirst);
  });

  it('re-fetches after tools/list_changed even while the ttlMs is fresh', async () => {
    const recordFile = makeRecordFile();
    const connection = await connect('modern', modernConfig(recordFile, { [MODERN_FIXTURE_LIST_TTL_ENV]: '600000' }));
    await connection.listTools();
    await connection.callTool({ name: 'trigger_list_changed', arguments: {}, signal: NEVER_ABORTED });
    const tools = await connection.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...MODERN_FIXTURE_TOOL_NAMES, 'added_later']);
    expect(listRecordCount(recordFile)).toBeGreaterThan(3);
  });

  it('re-lists a legacy server on every call because it sends no ttlMs', async () => {
    const connection = await connect('legacy', legacyConfig());
    expect((await connection.listTools()).map((tool) => tool.name)).toEqual([...LEGACY_FIXTURE_TOOL_NAMES]);
    expect((await connection.listTools()).map((tool) => tool.name)).toEqual([...LEGACY_FIXTURE_TOOL_NAMES]);
  });
});

describe('connectMcpServer callTool', () => {
  it('calls a tool by its original name on both fixtures', async () => {
    const modern = await connect('modern', modernConfig(makeRecordFile()));
    expect(textOf(await modern.callTool({ name: 'dotted.name/with-slash', arguments: {}, signal: NEVER_ABORTED }))).toBe('dotted');
    const legacy = await connect('legacy', legacyConfig());
    expect(textOf(await legacy.callTool({ name: 'add', arguments: { a: 40, b: 2 }, signal: NEVER_ABORTED }))).toBe('42');
  });

  it('fails with a typed error for a tool the server does not list, without calling the server', async () => {
    const recordFile = makeRecordFile();
    const connection = await connect('modern', modernConfig(recordFile));
    const failure = await connection.callTool({ name: 'not_listed', arguments: {}, signal: NEVER_ABORTED }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(McpUnknownToolError);
    expect(failure).toMatchObject({ server: 'modern', tool: 'not_listed' });
    expect(callRecords(recordFile, 'not_listed')).toEqual([]);
  });

  it('times out after timeoutMs and the server records the cancellation', async () => {
    const recordFile = makeRecordFile();
    const connection = await connect('modern', modernConfig(recordFile));
    await expect(connection.callTool({ name: 'slow', arguments: {}, signal: NEVER_ABORTED, timeoutMs: 300 })).rejects.toThrow();
    expect(await waitForRecord(recordFile, (record) => record.type === 'cancelled')).toMatchObject({ type: 'cancelled', tool: 'slow' });
  });

  it('aborts with the signal and the server records the cancellation', async () => {
    const recordFile = makeRecordFile();
    const connection = await connect('modern', modernConfig(recordFile));
    const controller = new AbortController();
    const settled = connection.callTool({ name: 'slow', arguments: {}, signal: controller.signal }).then(
      () => 'resolved',
      () => 'rejected',
    );
    await waitForRecord(recordFile, (record) => record.type === 'call' && record.tool === 'slow');
    controller.abort();
    expect(await settled).toBe('rejected');
    expect(await waitForRecord(recordFile, (record) => record.type === 'cancelled')).toMatchObject({ type: 'cancelled', tool: 'slow' });
  });

  it('sends traceparent and tracestate under _meta', async () => {
    const recordFile = makeRecordFile();
    const connection = await connect('modern', modernConfig(recordFile));
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    await connection.callTool({ name: 'echo', arguments: { text: 'x' }, signal: NEVER_ABORTED, traceparent, tracestate: 'vendor=fixture' });
    const [call] = callRecords(recordFile, 'echo');
    expect(call?.type === 'call' ? call.meta : undefined).toEqual({ traceparent, tracestate: 'vendor=fixture' });
  });
});

describe('the connect of a server against the limit of the connect', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const remoteServer = async (connection: { connectTimeoutMs?: number } = {}) => {
    const fixture = await startHttpFixture({ era: 'legacy' });
    const credentials = controlledCredentialStore();
    const harness = makeRemoteConnection({ fixture, store: credentials.store, connection: { name: 's', ...connection } });
    return { fixture, credentials, ...harness };
  };

  const expiredConnect = async (server: Awaited<ReturnType<typeof remoteServer>>, hungReads: number, limitMs: number): Promise<unknown> => {
    const attempt = outcomeOf(server.connection.connect());
    await server.credentials.arrived(hungReads, 'hang');
    await stillPendingAfter(attempt, limitMs - 1);
    await vi.advanceTimersByTimeAsync(1);
    await settledAfter(attempt);
    expect(attempt.state()).toBe('rejected');
    return attempt.error();
  };

  it.for([
    { connectTimeoutMs: undefined, limitMs: 30_000 },
    { connectTimeoutMs: 5000, limitMs: 5000 },
  ])('a stored-credential read that never settles ends the connect at connectTimeoutMs ($limitMs ms)', LIMIT_TEST, async ({ connectTimeoutMs, limitMs }) => {
    const server = await remoteServer(connectTimeoutMs === undefined ? {} : { connectTimeoutMs });
    server.credentials.mode = 'hang';
    useLimitTimers();

    const failure = await expiredConnect(server, 1, limitMs);

    expect((failure as Error).message).toBe(keyReadLimitSentence('the MCP connect limit', limitMs));
    expect(server.connection.diagnostics().lastError).toBe(keyReadLimitSentence('the MCP connect limit', limitMs));
    expect(server.connection.diagnostics().state).toBe('disconnected');
  });

  it('a connect that hangs outside the store has the limit text', LIMIT_TEST, async () => {
    const connection = createManagedConnection({ files: nodeFileSystem,
      clientVersion: '0.0.0-test',
      name: 's',
      config: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
      scope: 'user',
      projectDir: makeDir(),
      baseEnv: BASE_ENV,
      clock: createFakeClock(1_000_000),
      random: () => 0,
    });
    onCleanup(() => connection.close());
    useLimitTimers();

    const attempt = outcomeOf(connection.connect());
    await limitArmed();
    await stillPendingAfter(attempt, 29_999);
    await vi.advanceTimersByTimeAsync(1);
    await settledAfter(attempt);

    expect(attempt.state()).toBe('rejected');
    expect((attempt.error() as Error).message).toBe('the connect did not finish within the MCP connect limit of 30000 ms');
    expect(connection.diagnostics().state).toBe('disconnected');
  });

  it('three connect expiries open the breaker', LIMIT_TEST, async () => {
    const server = await remoteServer();
    server.credentials.mode = 'hang';
    useLimitTimers();
    const sentence = keyReadLimitSentence('the MCP connect limit', 30_000);

    for (const expiry of [1, 2, 3]) expect(((await expiredConnect(server, expiry, 30_000)) as Error).message).toBe(sentence);
    expect(server.connection.diagnostics().state).toBe('unavailable');
    const refused = outcomeOf(server.connection.connect());
    await settledAfter(refused);

    expect(refused.error()).toBeInstanceOf(McpUnavailableError);
    expect((refused.error() as Error).message).toBe(`MCP server "s" is unavailable: ${sentence}`);
    expect(server.credentials.calls).toHaveLength(3);

    server.clock.advance(60_000);
    server.credentials.mode = 'answer';
    const passed = outcomeOf(server.connection.connect());
    await settledAfter(passed);

    expect(passed.state()).toBe('fulfilled');
    expect(server.credentials.calls.length).toBeGreaterThan(3);
    expect(server.connection.diagnostics()).toMatchObject({ state: 'connected', lastError: null });
  });

  it('an absent store is a deterministic connect failure', async () => {
    const server = await remoteServer();
    server.credentials.mode = 'absent';

    for (const attemptNumber of [1, 2, 3, 4]) {
      const failure: unknown = await server.connection.connect().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).not.toBeInstanceOf(McpUnavailableError);
      expect((failure as Error).message).toBe(NO_STORE_REFUSAL);
      expect(server.credentials.calls).toHaveLength(attemptNumber);
      expect(server.connection.diagnostics()).toMatchObject({ state: 'disconnected', lastError: NO_STORE_REFUSAL });
    }
    expect(server.credentials.calls.at(-1)?.rejection).toBeInstanceOf(CredentialStoreError);
  });
});

describe('the signal of a tool call', () => {
  it('McpCallToolInput.signal is required', () => {
    expectTypeOf<McpCallToolInput['signal']>().toEqualTypeOf<AbortSignal>();
  });
});
