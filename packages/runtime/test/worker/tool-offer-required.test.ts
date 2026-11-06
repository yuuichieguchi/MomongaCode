import { describe, expect, it } from 'vitest';
import type { FunctionTool } from '@momonga/protocol';
import { createToolRegistry, defineTool, extendToolSet } from '@momonga/tools';
import type { AnyTool, ToolSet } from '@momonga/tools';
import { LOAD_TOOLS_TOOL_NAME, offerFor } from '../../src/worker/tool-offer.ts';
import type { ToolOfferInput } from '../../src/worker/tool-offer.ts';

const readOnly = (name: string, description: string, tier: 'essential' | 'common' | 'optional'): AnyTool =>
  defineTool<Record<string, unknown>>({
    name,
    description,
    tier,
    kind: 'read',
    sideEffect: 'read_only',
    subject: () => ({ kind: 'none', tool: name }),
    inputSchema: { type: 'object', properties: { value: { type: 'string', description: `The value that ${name} works on` } }, required: ['value'], additionalProperties: false },
    timeoutMs: 1_000,
    title: () => name,
    execute: async () => ({ status: 'completed' as const, output: name }),
  });

const TOOLS = [
  readOnly('ReadOutput', 'Reads a stored output.', 'essential'),
  readOnly('Alpha', 'Reads the alpha.\nIt also explains the alpha in detail.', 'common'),
  readOnly('HistoryRead', 'Reads the recorded events of a run in a seq range.\nIt also explains the range in detail.', 'optional'),
];

const toolSet = async (): Promise<ToolSet> => {
  const registry = createToolRegistry();
  for (const tool of TOOLS) registry.register(tool);
  return extendToolSet(await registry.snapshot(), readOnly(LOAD_TOOLS_TOOL_NAME, 'Loads tools.', 'essential'));
};

const namesOf = (tools: readonly FunctionTool[]): string[] => tools.map((tool) => tool.name);

const offer = async (required: readonly string[]) => {
  const set = await toolSet();
  const visible = set.forModel({ mode: 'default', rules: [] });
  return offerFor({ toolSet: set, visible, deferred: ['Alpha', 'HistoryRead', 'ReadOutput'], loaded: [], keepCompanionsWithoutHost: false, required: new Set(required) } as ToolOfferInput);
};

describe('deferral never withholds the reader of a pointer the context holds', () => {
  it('defers HistoryRead into the catalog before a compaction', async () => {
    const before = await offer([]);
    expect(before.catalog).toContain('HistoryRead');
    expect(namesOf(before.tools)).not.toContain('HistoryRead');
  });

  it('offers HistoryRead in place once a range was replaced', async () => {
    const after = await offer(['HistoryRead']);
    expect(after.catalog).not.toContain('HistoryRead');
    expect(namesOf(after.tools)).toContain('HistoryRead');
    expect(namesOf(after.tools)).toContain(LOAD_TOOLS_TOOL_NAME);
    expect(after.catalog).toEqual(['Alpha']);
  });

  it('leaves ReadOutput in place in both cases, as the essential tier did', async () => {
    expect(namesOf((await offer([])).tools)).toContain('ReadOutput');
    expect(namesOf((await offer(['HistoryRead'])).tools)).toContain('ReadOutput');
  });
});
