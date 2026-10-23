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

describe('ToolDefinition.schemaMode', () => {
  it('defaults to strict, so a builtin with an unknown keyword is rejected at register', () => {
    const registry = createToolRegistry();
    expect(() => registry.register(makeTool('Strict', { inputSchema: { type: 'object', properties: {}, 'x-vendor': true } }))).toThrow();
  });

  it('keeps strict compilation for a source tool without schemaMode and reports it', async () => {
    const set = await snapshotOf(makeTool('mcp__srv__strict', { inputSchema: { type: 'object', properties: {}, 'x-vendor': true } }));
    expect(set.get('mcp__srv__strict')).toBeUndefined();
    expect(set.notices.filter((notice) => notice.includes('mcp__srv__strict'))).toHaveLength(1);
  });

  it('accepts unknown keywords and unknown formats in lenient mode', async () => {
    const tool = makeTool('mcp__srv__lenient', {
      schemaMode: 'lenient',
      inputSchema: { type: 'object', properties: { when: { type: 'string', format: 'vendor-date' } }, 'x-vendor': true },
    });
    const set = await snapshotOf(tool);
    expect(set.notices).toEqual([]);
    expect(set.get('mcp__srv__lenient')?.name).toBe('mcp__srv__lenient');
    expect(validateToolInput(tool, { when: 'anything' })).toEqual({ ok: true, value: { when: 'anything' } });
    expect(validateToolInput(tool, { when: 3 }).ok).toBe(false);
  });

  it('still enforces known formats in lenient mode', () => {
    const tool = makeTool('mcp__srv__email', {
      schemaMode: 'lenient',
      inputSchema: { type: 'object', properties: { to: { type: 'string', format: 'email' } } },
    });
    expect(validateToolInput(tool, { to: 'user@example.com' }).ok).toBe(true);
    expect(validateToolInput(tool, { to: 'not an email' }).ok).toBe(false);
  });

  it('compiles a draft-07 schema in lenient mode with draft-07 semantics', async () => {
    const tool = makeTool('mcp__srv__draft07', { schemaMode: 'lenient', inputSchema: draft07Schema() });
    const set = await snapshotOf(tool);
    expect(set.notices).toEqual([]);
    expect(set.get('mcp__srv__draft07')?.name).toBe('mcp__srv__draft07');
    expect(validateToolInput(tool, { a: 'x', b: 'y' }).ok).toBe(true);
    expect(validateToolInput(tool, { a: 'x' }).ok).toBe(false);
  });

  it('reports a draft-07 schema in strict mode instead of registering it', async () => {
    const set = await snapshotOf(makeTool('mcp__srv__draft07strict', { inputSchema: draft07Schema() }));
    expect(set.get('mcp__srv__draft07strict')).toBeUndefined();
    expect(set.notices.filter((notice) => notice.includes('mcp__srv__draft07strict'))).toHaveLength(1);
  });

  it('skips a lenient schema that still cannot compile and reports it', async () => {
    const set = await snapshotOf(
      makeTool('mcp__srv__broken', { schemaMode: 'lenient', inputSchema: { type: 'object', properties: { a: { type: 'strin' } } } }),
    );
    expect(set.get('mcp__srv__broken')).toBeUndefined();
    expect(set.notices.filter((notice) => notice.includes('mcp__srv__broken'))).toHaveLength(1);
  });

  it('accepts a lenient tool registered directly', async () => {
    const registry = createToolRegistry();
    registry.register(makeTool('LenientBuiltin', { schemaMode: 'lenient', inputSchema: { type: 'object', properties: {}, 'x-vendor': true } }));
    expect((await registry.snapshot()).get('LenientBuiltin')?.schemaMode).toBe('lenient');
  });
});
