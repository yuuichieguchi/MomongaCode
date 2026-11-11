import { nodeFileSystem } from '@momonga/foundation';
import { describe, expect, it, vi } from 'vitest';
import { createManagedConnection } from '@momonga/mcp';
import { LEGACY_FIXTURE_PROTOCOL_VERSION, REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, TEST_STDIO_LAUNCH } from '@momonga/testkit';
import { BASE_ENV, makeDir, onCleanup } from './mcp-harness.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const RECORDING_SERVER = `
const lines = require('node:readline').createInterface({ input: process.stdin });
const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    process.stderr.write('clientInfo=' + JSON.stringify(message.params.clientInfo) + '\\n');
    write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: ${JSON.stringify(LEGACY_FIXTURE_PROTOCOL_VERSION)}, capabilities: { tools: {} }, serverInfo: { name: 'version-fixture', version: '1.0.0' } } });
    return;
  }
  if (message.method === 'tools/list') {
    write({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
    return;
  }
  write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found: ' + message.method } });
});
lines.on('close', () => process.exit(0));
`;

describe('the MCP client reports the version it was given', () => {
  it('the clientInfo of the initialize message carries the product name and the clientVersion of the connection', async () => {
    const connection = createManagedConnection({ launch: TEST_STDIO_LAUNCH, files: nodeFileSystem,
      name: 'recorder',
      config: { command: process.execPath, args: ['-e', RECORDING_SERVER] },
      scope: 'user',
      projectDir: makeDir(),
      baseEnv: BASE_ENV,
      clock: createFakeClock(1_000_000),
      random: () => 0,
      closeGraceMs: 200,
      clientVersion: '9.8.7-test',
    });
    onCleanup(() => connection.close());

    await connection.listTools();

    const recorded = connection
      .diagnostics()
      .stderrTail.split('\n')
      .find((line) => line.startsWith('clientInfo='));
    expect(JSON.parse((recorded as string).slice('clientInfo='.length))).toEqual({ name: 'momonga', version: '9.8.7-test' });
  });
});
