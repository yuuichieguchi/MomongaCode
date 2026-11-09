import { describe, expect, it } from 'vitest';
import type { Tool } from '@modelcontextprotocol/client';
import { createMcpToolSource } from '@momonga/mcp';
import type { McpServerConnection } from '@momonga/mcp';
import { keyFor } from '../../tools/test/helpers.ts';
import { resultOf, runOne, world } from '../../tools/test/guard-world.ts';

const tools: Tool[] = [
  { name: 'look', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'change', inputSchema: { type: 'object' } },
  { name: 'erase', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, destructiveHint: true } },
];

const connection = {
  name: 'srv',
  protocolVersion: undefined,
  protocolEra: undefined,
  serverInfo: undefined,
  instructions: undefined,
  listTools: async () => tools,
  callTool: async () => ({ content: [{ type: 'text', text: 'done' }] }),
  releaseCheckpoint: async () => undefined,
  redact: (text: string) => text,
  diagnostics: () => ({}),
  close: async () => undefined,
} as unknown as McpServerConnection;

describe('T8 the guard applies to MCP tools by their sideEffect (mcp/src/source.ts readOnlyHint and destructiveHint)', () => {
  it('while a marker is unsettled, a readOnlyHint tool runs and a tool without it, or with destructiveHint, is refused', async () => {
    const mcpTools = await createMcpToolSource({ server: 'srv', connection }).list();
    const h = world('held');
    await runOne(h, 'Leaver', 'first');
    const name = keyFor('run-1', 1, 'first');
    expect(resultOf(await runOne(h, 'mcp__srv__look', 'look', mcpTools)).status).toBe('completed');
    for (const [tool, callId] of [['mcp__srv__change', 'change'], ['mcp__srv__erase', 'erase']] as const) {
      const refused = resultOf(await runOne(h, tool, callId, mcpTools));
      expect({ tool, status: refused.status, names: refused.output.includes(`marker ${name}`) }).toEqual({ tool, status: 'failed', names: true });
    }
  });
});
