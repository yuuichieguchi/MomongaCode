import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { createToolRegistry, extendToolSet } from '@momonga/tools';
import type { AnyTool, ToolSource } from '@momonga/tools';
import { makeTool } from './harness.ts';
import { makeLayout, ruleFor } from './helpers.ts';

const digestOf = (tools: AnyTool[]): string =>
  sha256Hex(
    canonicalJson(
      tools.map((tool) => [tool.name, tool.description, tool.kind, tool.sideEffect, tool.inputSchema, tool.conciseDescription ?? null, tool.conciseParameterDescriptions ?? null]),
    ),
  );

const source = (id: string, tools: AnyTool[]): ToolSource => ({ id, list: async () => tools });

describe('createToolRegistry register', () => {
  it('accepts a 64-character name made of letters, digits, underscore and dash', async () => {
    const registry = createToolRegistry();
    const name = `${'a'.repeat(30)}_B-9${'z'.repeat(30)}`;
    expect(name).toHaveLength(64);
    registry.register(makeTool(name));
    expect((await registry.snapshot()).get(name)?.name).toBe(name);
  });

  it('throws on a duplicate name', () => {
    const registry = createToolRegistry();
    registry.register(makeTool('Read'));
    expect(() => registry.register(makeTool('Read'))).toThrow();
  });

  it.each(['', 'has space', 'dot.name', 'slash/name', 'a'.repeat(65), 'ünicode'])('throws on invalid name %j', (name) => {
    const registry = createToolRegistry();
    expect(() => registry.register(makeTool(name))).toThrow();
  });

  it.each([
    ['array root', { type: 'array', items: { type: 'string' } }],
    ['missing root type', { properties: { a: { type: 'string' } } }],
    ['string root', { type: 'string' }],
  ])('throws when the schema root is not an object (%s)', (_label, inputSchema) => {
    const registry = createToolRegistry();
    expect(() => registry.register(makeTool('Bad', { inputSchema }))).toThrow();
  });

  it.each([
    ['unknown type name', { type: 'object', properties: { a: { type: 'strin' } } }],
    ['unresolvable $ref', { type: 'object', properties: { a: { $ref: '#/$defs/missing' } } }],
    ['unsupported dialect', { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object' }],
  ])('throws when the schema cannot be compiled (%s)', (_label, inputSchema) => {
    const registry = createToolRegistry();
    expect(() => registry.register(makeTool('Bad', { inputSchema }))).toThrow();
  });

  it('does not keep a rejected tool', async () => {
    const registry = createToolRegistry();
    expect(() => registry.register(makeTool('Bad', { inputSchema: { type: 'array' } }))).toThrow();
    const set = await registry.snapshot();
    expect(set.tools).toHaveLength(0);
    expect(set.get('Bad')).toBeUndefined();
  });
});

describe('createToolRegistry sources', () => {
  it('orders builtins and source tools by tier, then by name, whatever the registration, source and listing order', async () => {
    const registry = createToolRegistry();
    registry.register(makeTool('B1'));
    registry.addSource(source('s1', [makeTool('S1b'), makeTool('S1a')]));
    registry.register(makeTool('A2'));
    registry.addSource(source('s2', [makeTool('S2')]));
    const set = await registry.snapshot();
    expect(set.tools.map((tool) => tool.name)).toEqual(['A2', 'B1', 'S1a', 'S1b', 'S2']);
    expect(set.notices).toEqual([]);
  });

  it('skips a source tool that collides with a builtin and reports it', async () => {
    const registry = createToolRegistry();
    const builtin = makeTool('Read');
    registry.register(builtin);
    registry.addSource(source('mcp-files', [makeTool('Read', { description: 'impostor' }), makeTool('Other')]));
    const set = await registry.snapshot();
    expect(set.tools.map((tool) => tool.name)).toEqual(['Other', 'Read']);
    expect(set.get('Read')?.description).toBe('Read test tool');
    expect(set.notices).toHaveLength(1);
    expect(set.notices[0]).toContain('Read');
    expect(set.notices[0]).toContain('mcp-files');
  });

  it('skips a tool that collides with an earlier source', async () => {
    const registry = createToolRegistry();
    registry.addSource(source('first', [makeTool('Shared', { description: 'first' })]));
    registry.addSource(source('second', [makeTool('Shared', { description: 'second' })]));
    const set = await registry.snapshot();
    expect(set.tools).toHaveLength(1);
    expect(set.get('Shared')?.description).toBe('first');
    expect(set.notices).toHaveLength(1);
    expect(set.notices[0]).toContain('second');
  });

  it('turns a rejecting source into a notice without tools', async () => {
    const registry = createToolRegistry();
    registry.register(makeTool('Read'));
    registry.addSource({ id: 'broken-src', list: async () => Promise.reject(new Error('connection refused')) });
    registry.addSource(source('ok-src', [makeTool('Fine')]));
    const set = await registry.snapshot();
    expect(set.tools.map((tool) => tool.name)).toEqual(['Fine', 'Read']);
    expect(set.notices).toHaveLength(1);
    expect(set.notices[0]).toContain('broken-src');
  });

  it('skips invalid source tools with notices', async () => {
    const registry = createToolRegistry();
    registry.addSource(
      source('weird', [makeTool('bad name'), makeTool('BadSchema', { inputSchema: { type: 'array' } }), makeTool('Good')]),
    );
    const set = await registry.snapshot();
    expect(set.tools.map((tool) => tool.name)).toEqual(['Good']);
    expect(set.notices).toHaveLength(2);
    expect(set.notices.some((notice) => notice.includes('bad name'))).toBe(true);
    expect(set.notices.some((notice) => notice.includes('BadSchema'))).toBe(true);
  });
});

describe('ToolSet snapshot', () => {
  it('computes the digest of a tool with a concise variant and of one without from the same seven fields', async () => {
    const registry = createToolRegistry();
    const read = makeTool('Read');
    const grep = { ...makeTool('Grep'), conciseDescription: 'Searches.', conciseParameterDescriptions: { pattern: 'Regex.' } } as AnyTool;
    registry.register(read);
    registry.register(grep);
    expect((await registry.snapshot()).digest).toBe(digestOf([grep, read]));
  });

  it('computes the digest from name, description, kind, sideEffect, inputSchema and the concise variant in order', async () => {
    const registry = createToolRegistry();
    const read = makeTool('Read');
    const write = makeTool('Write', { kind: 'edit', sideEffect: 'write', subjectKind: 'none' });
    registry.register(read);
    registry.register(write);
    const set = await registry.snapshot();
    expect(set.digest).toBe(digestOf([read, write]));
    expect(set.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across snapshots and registries with the same tools', async () => {
    const first = createToolRegistry();
    const second = createToolRegistry();
    first.register(makeTool('Read'));
    second.register(makeTool('Read'));
    expect((await first.snapshot()).digest).toBe((await first.snapshot()).digest);
    expect((await first.snapshot()).digest).toBe((await second.snapshot()).digest);
  });

  it.each([
    ['description', { description: 'changed' }],
    ['schema', { inputSchema: { type: 'object', properties: { other: { type: 'string' } } } }],
    ['kind', { kind: 'search' as const }],
    ['sideEffect', { sideEffect: 'exec' as const, subjectKind: 'none' as const }],
  ])('changes the digest when the %s changes', async (_label, overrides) => {
    const base = createToolRegistry();
    const changed = createToolRegistry();
    base.register(makeTool('Read'));
    changed.register(makeTool('Read', overrides));
    expect((await changed.snapshot()).digest).not.toBe((await base.snapshot()).digest);
  });

  it('is frozen: later registrations do not change an existing snapshot', async () => {
    const registry = createToolRegistry();
    registry.register(makeTool('Read'));
    const before = await registry.snapshot();
    const digestBefore = before.digest;
    registry.register(makeTool('Write'));
    expect(before.tools.map((tool) => tool.name)).toEqual(['Read']);
    expect(before.get('Write')).toBeUndefined();
    expect(before.digest).toBe(digestBefore);
    const after = await registry.snapshot();
    expect(after.tools.map((tool) => tool.name)).toEqual(['Read', 'Write']);
    expect(after.digest).not.toBe(digestBefore);
    expect(Object.isFrozen(before.tools)).toBe(true);
    expect(Object.isFrozen(before.notices)).toBe(true);
  });

  it('get returns undefined for unknown names', async () => {
    const registry = createToolRegistry();
    registry.register(makeTool('Read'));
    expect((await registry.snapshot()).get('Nope')).toBeUndefined();
  });
});

describe('ToolSet forModel', () => {
  const build = async () => {
    const registry = createToolRegistry();
    registry.register(makeTool('Read'));
    registry.register(makeTool('Write', { kind: 'edit', sideEffect: 'write', subjectKind: 'none' }));
    registry.register(makeTool('Bash', { kind: 'execute', sideEffect: 'exec', subjectKind: 'command', subject: () => ({ kind: 'command', tool: 'Bash', command: 'true' }) }));
    return registry.snapshot();
  };

  it('maps every visible tool to a FunctionTool', async () => {
    const set = await build();
    const read = set.get('Read');
    expect(set.forModel({ mode: 'manual', rules: [] })).toEqual([
      { type: 'function', name: 'Bash', description: 'Bash test tool', parameters: set.get('Bash')?.inputSchema, strict: false, fitRank: 0, fitTier: 'common' },
      { type: 'function', name: 'Read', description: 'Read test tool', parameters: read?.inputSchema, strict: false, fitRank: 1, fitTier: 'common' },
      { type: 'function', name: 'Write', description: 'Write test tool', parameters: set.get('Write')?.inputSchema, strict: false, fitRank: 2, fitTier: 'common' },
    ]);
  });

  it('hides non-read-only tools except Bash in plan mode', async () => {
    const set = await build();
    expect(set.forModel({ mode: 'plan', rules: [] }).map((tool) => tool.name)).toEqual(['Bash', 'Read']);
  });

  it('hides tools covered by a blanket deny rule but not by a specific deny rule', async () => {
    const set = await build();
    const rule = ruleFor(makeLayout());
    expect(set.forModel({ mode: 'manual', rules: [rule('deny', 'Bash')] }).map((tool) => tool.name)).toEqual(['Read', 'Write']);
    expect(set.forModel({ mode: 'manual', rules: [rule('deny', 'Bash(rm:*)')] }).map((tool) => tool.name)).toEqual([
      'Bash',
      'Read',
      'Write',
    ]);
  });
});

describe('extendToolSet', () => {
  it('admits a tool through the same schema check as register', async () => {
    const registry = createToolRegistry();
    registry.register(makeTool('One'));
    const set = await registry.snapshot();
    const extended = extendToolSet(set, makeTool('Two'));
    expect(extended.get('Two')?.name).toBe('Two');
    expect(extended.tools.map((tool) => tool.name)).toEqual(['One', 'Two']);
    expect(() => extendToolSet(set, makeTool('Bad', { inputSchema: { type: 'object', properties: { a: { type: 'strin' } } } }))).toThrow();
    expect(() => extendToolSet(set, makeTool('One'))).toThrow('duplicate tool name');
  });
});
