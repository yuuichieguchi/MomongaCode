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

describe('T8 the guard applies to every MCP tool as to a tool that changes things: a hint of its server never sets the safety class', () => {
  it('while a marker is unsettled, a tool is refused with a readOnlyHint, without one, and with a destructiveHint', async () => {
    const mcpTools = await createMcpToolSource({ server: 'srv', connection }).list();
    const h = world('held');
    await runOne(h, 'Leaver', 'first');
    const name = keyFor('run-1', 1, 'first');
    expect(mcpTools.map((tool) => [tool.name, tool.kind, tool.sideEffect])).toEqual([
      ['mcp__srv__look', 'other', 'write'],
      ['mcp__srv__change', 'other', 'write'],
      ['mcp__srv__erase', 'other', 'write'],
    ]);
    for (const [tool, callId] of [['mcp__srv__look', 'look'], ['mcp__srv__change', 'change'], ['mcp__srv__erase', 'erase']] as const) {
      const refused = resultOf(await runOne(h, tool, callId, mcpTools));
      expect({ tool, status: refused.status, names: refused.output.includes(`marker ${name}`) }).toEqual({ tool, status: 'failed', names: true });
    }
  });
});
