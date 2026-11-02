import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { connectMcpServer, type McpServerConnection } from '@momonga/mcp';
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
  const connection = await connectMcpServer({
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
    expect(groupExists(diagnostics.pgid as number)).toBe(true);
  });

  it('closes and reaps the server process group', async () => {
    const connection = await connect('modern', modernConfig(makeRecordFile()));
    const pgid = connection.diagnostics().pgid as number;
    await connection.close();
    expect(groupExists(pgid)).toBe(false);
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
      connectMcpServer({
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
    await connection.callTool({ name: 'trigger_list_changed', arguments: {} });
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
    expect(textOf(await modern.callTool({ name: 'dotted.name/with-slash', arguments: {} }))).toBe('dotted');
    const legacy = await connect('legacy', legacyConfig());
    expect(textOf(await legacy.callTool({ name: 'add', arguments: { a: 40, b: 2 } }))).toBe('42');
  });

  it('times out after timeoutMs and the server records the cancellation', async () => {
    const recordFile = makeRecordFile();
    const connection = await connect('modern', modernConfig(recordFile));
    await expect(connection.callTool({ name: 'slow', arguments: {}, timeoutMs: 300 })).rejects.toThrow();
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
    await connection.callTool({ name: 'echo', arguments: { text: 'x' }, traceparent, tracestate: 'vendor=fixture' });
    const [call] = callRecords(recordFile, 'echo');
    expect(call?.type === 'call' ? call.meta : undefined).toEqual({ traceparent, tracestate: 'vendor=fixture' });
  });
});
