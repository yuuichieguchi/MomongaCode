import { describe, expect, it } from 'vitest';
import { createToolRegistry, validateToolInput } from '@momonga/tools';
import type { AnyTool, ToolSource } from '@momonga/tools';
import { makeTool } from './harness.ts';

const source = (tools: AnyTool[]): ToolSource => ({ id: 'mcp__srv', list: async () => tools });

const draft07Schema = (): Record<string, unknown> => ({
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: { a: { type: 'string' }, b: { type: 'string' } },
  dependencies: { a: ['b'] },
  definitions: { unused: { type: 'string' } },
});

const snapshotOf = async (tool: AnyTool) => {
  const registry = createToolRegistry();
  registry.addSource(source([tool]));
  return registry.snapshot();
};

describe('every tool schema goes through the one validator', () => {
  it('accepts unknown keywords and unknown formats', async () => {
    const tool = makeTool('mcp__srv__lenient', {
      inputSchema: { type: 'object', properties: { when: { type: 'string', format: 'vendor-date' } }, 'x-vendor': true },
    });
    const set = await snapshotOf(tool);
    expect(set.notices).toEqual([]);
    expect(set.get('mcp__srv__lenient')?.name).toBe('mcp__srv__lenient');
    expect(validateToolInput(tool, { when: 'anything' })).toEqual({ ok: true, value: { when: 'anything' } });
    expect(validateToolInput(tool, { when: 3 }).ok).toBe(false);
  });

  it('treats a known format as an annotation', () => {
    const tool = makeTool('mcp__srv__email', { inputSchema: { type: 'object', properties: { to: { type: 'string', format: 'email' } } } });
    expect(validateToolInput(tool, { to: 'user@example.com' }).ok).toBe(true);
    expect(validateToolInput(tool, { to: 'not an email' }).ok).toBe(true);
  });

  it('compiles a draft-07 schema with draft-07 semantics', async () => {
    const tool = makeTool('mcp__srv__draft07', { inputSchema: draft07Schema() });
    const set = await snapshotOf(tool);
    expect(set.notices).toEqual([]);
    expect(set.get('mcp__srv__draft07')?.name).toBe('mcp__srv__draft07');
    expect(validateToolInput(tool, { a: 'x', b: 'y' }).ok).toBe(true);
    expect(validateToolInput(tool, { a: 'x' }).ok).toBe(false);
  });

  it('skips a schema that cannot compile and reports it', async () => {
    const set = await snapshotOf(makeTool('mcp__srv__broken', { inputSchema: { type: 'object', properties: { a: { type: 'strin' } } } }));
    expect(set.get('mcp__srv__broken')).toBeUndefined();
    expect(set.notices.filter((notice) => notice.includes('mcp__srv__broken'))).toHaveLength(1);
  });

  it('accepts a tool registered directly with an unknown keyword', async () => {
    const registry = createToolRegistry();
    registry.register(makeTool('Direct', { inputSchema: { type: 'object', properties: {}, 'x-vendor': true } }));
    expect((await registry.snapshot()).get('Direct')?.name).toBe('Direct');
  });
});
