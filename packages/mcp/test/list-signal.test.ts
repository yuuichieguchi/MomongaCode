import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createManagedConnection, createMcpPool, createMcpToolSource } from '@momonga/mcp';
import type { McpConnectionOptions, McpPoolOptions, McpServerConnection } from '@momonga/mcp';
import { MCP_MODERN_SERVER_PATH, MODERN_FIXTURE_TOOL_NAMES, REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock } from '@momonga/testkit';
import { BASE_ENV, groupExists, makeDir, onCleanup } from './raw-transport.ts';

const transportCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('../src/stdio-transport.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/stdio-transport.ts')>();
  return {
    ...original,
    createStdioTransport: (options: Parameters<typeof original.createStdioTransport>[0]) => {
      transportCalls.push({ ...options });
      return original.createStdioTransport(options);
    },
  };
});

const PROCESS_TIMEOUT = { timeout: REAL_PROCESS_TEST_TIMEOUT_MS };

const modernServer = { command: process.execPath, args: [MCP_MODERN_SERVER_PATH] };

const connectionFor = (extra: Partial<McpConnectionOptions> = {}): McpServerConnection => {
  const connection = createManagedConnection({
    name: 'modern',
    config: modernServer,
    scope: 'user',
    projectDir: makeDir(),
    baseEnv: BASE_ENV,
    clock: createFakeClock(1_000_000),
    random: () => 0,
    ...extra,
  });
  onCleanup(() => connection.close());
  return connection;
};

type ListWithSignal = (options?: { signal?: AbortSignal }) => Promise<Array<{ name: string }>>;

describe('MCP listTools signal', () => {
  it('an aborted signal rejects listTools with the reason while the shared connect still serves another caller', PROCESS_TIMEOUT, async () => {
    const connection = connectionFor();
    const listTools = connection.listTools.bind(connection) as ListWithSignal;
    const controller = new AbortController();
    const reason = new Error('the run was cancelled');

    const abandoned = listTools({ signal: controller.signal });
    const other = listTools();
    other.catch(() => undefined);
    controller.abort(reason);

    await expect(abandoned).rejects.toBe(reason);
    const tools = await other;
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([...MODERN_FIXTURE_TOOL_NAMES.slice(0, 3)]));
    expect(connection.diagnostics().state).toBe('connected');
  });

  it('an already aborted signal rejects listTools on an established session without closing it', PROCESS_TIMEOUT, async () => {
    const connection = connectionFor();
    const listTools = connection.listTools.bind(connection) as ListWithSignal;
    await connection.listTools();
    const controller = new AbortController();
    const reason = new Error('already cancelled');
    controller.abort(reason);

    await expect(listTools({ signal: controller.signal })).rejects.toThrow();
    expect(connection.diagnostics().state).toBe('connected');
    expect((await connection.listTools()).length).toBeGreaterThan(0);
  });

  it('close aborts a pending connect', PROCESS_TIMEOUT, async () => {
    const connection = connectionFor();
    const pending = connection.listTools();
    pending.catch(() => undefined);

    await connection.close();

    await expect(pending).rejects.toThrow();
    const pgid = connection.diagnostics().pgid;
    if (pgid !== undefined) expect(groupExists(pgid)).toBe(false);
  });

  it('closeGraceMs threads from pool to transport', PROCESS_TIMEOUT, async () => {
    const markerDir = path.join(makeDir(), 'markers');
    fs.mkdirSync(markerDir, { mode: 0o700 });
    const onWarning = (): void => undefined;
    transportCalls.length = 0;
    const pool = createMcpPool({
      servers: [{ name: 'modern', scope: 'user', config: modernServer }],
      projectDir: makeDir(),
      baseEnv: BASE_ENV,
      clock: createFakeClock(1_000_000),
      random: () => 0,
      closeGraceMs: 1234,
      markers: { dir: markerDir, onWarning },
    } as McpPoolOptions);
    onCleanup(() => pool.close());

    await pool.sources[0]?.list();

    expect(transportCalls).toHaveLength(1);
    expect(transportCalls[0]).toMatchObject({ name: 'modern', closeGraceMs: 1234, markers: { dir: markerDir, onWarning } });
  });

  it('closeGraceMs and markers thread from a connection to its transport', PROCESS_TIMEOUT, async () => {
    const markerDir = path.join(makeDir(), 'markers');
    fs.mkdirSync(markerDir, { mode: 0o700 });
    const onWarning = (): void => undefined;
    transportCalls.length = 0;
    const connection = connectionFor({ closeGraceMs: 777, markers: { dir: markerDir, onWarning } } as Partial<McpConnectionOptions>);

    await connection.listTools();

    expect(transportCalls[0]).toMatchObject({ closeGraceMs: 777, markers: { dir: markerDir, onWarning } });
  });

  it.each(['list', 'listWithNotices'] as const)('the MCP source %s forwards the signal to listTools', async (method) => {
    const seen: Array<{ signal?: AbortSignal } | undefined> = [];
    const connection = {
      name: 'fake',
      protocolVersion: undefined,
      protocolEra: undefined,
      serverInfo: undefined,
      instructions: undefined,
      listTools: async (options?: { signal?: AbortSignal }) => {
        seen.push(options);
        return [];
      },
      callTool: () => Promise.reject(new Error('callTool is not used by this test')),
      diagnostics: () => {
        throw new Error('diagnostics are not used by this test');
      },
      close: async () => undefined,
    } as unknown as McpServerConnection;
    const source = createMcpToolSource({ server: 'fake', connection });
    const controller = new AbortController();
    const listing = source[method] as ((options?: { signal?: AbortSignal }) => Promise<unknown>) | undefined;

    await listing?.({ signal: controller.signal });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.signal).toBe(controller.signal);
  });
});
