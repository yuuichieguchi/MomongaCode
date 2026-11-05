import { describe, expect, it } from 'vitest';
import { compileUntrustedSchema, untrustedSchemaCacheSize } from '@momonga/foundation';
import { createToolRegistry } from '@momonga/tools';
import { makeTool } from './harness.ts';

const SHARED_ID = 'https://untrusted.example/shared';

const identified = (label: string): Record<string, unknown> => ({
  $id: SHARED_ID,
  type: 'object',
  properties: { [label]: { type: 'string' } },
  required: [label],
});

describe('compileUntrustedSchema', () => {
  it('compiles two distinct schemas that declare the same $id, each with its own semantics', () => {
    const first = compileUntrustedSchema(identified('alpha'));
    const second = compileUntrustedSchema(identified('beta'));
    expect(first({ alpha: 'a' })).toBe(true);
    expect(first({ beta: 'b' })).toBe(false);
    expect(second({ beta: 'b' })).toBe(true);
    expect(second({ alpha: 'a' })).toBe(false);
  });

  it('never resolves a $ref to an $id declared by another compiled schema', () => {
    compileUntrustedSchema({ $id: 'https://server-a.example/secret', type: 'object', properties: { s: { type: 'string' } } });
    expect(() =>
      compileUntrustedSchema({ type: 'object', properties: { x: { $ref: 'https://server-a.example/secret' } } }),
    ).toThrow();
  });

  it('reports a source tool whose schema refers to another source tool $id', async () => {
    const registry = createToolRegistry();
    registry.addSource({
      id: 'mcp__a',
      list: async () => [
        makeTool('mcp__a__owner', {
          schemaMode: 'lenient',
          inputSchema: { $id: 'https://server-a.example/owner', type: 'object', properties: { s: { type: 'string' } } },
        }),
      ],
    });
    registry.addSource({
      id: 'mcp__b',
      list: async () => [
        makeTool('mcp__b__thief', {
          schemaMode: 'lenient',
          inputSchema: { type: 'object', properties: { x: { $ref: 'https://server-a.example/owner' } } },
        }),
      ],
    });
    const set = await registry.snapshot();
    expect(set.get('mcp__a__owner')?.name).toBe('mcp__a__owner');
    expect(set.get('mcp__b__thief')).toBeUndefined();
    expect(set.notices.filter((notice) => notice.includes('mcp__b__thief'))).toHaveLength(1);
  });

  it('reuses one compiled validator for equal schemas given as distinct objects', () => {
    const schema = (): Record<string, unknown> => ({ type: 'object', properties: { reuse: { type: 'integer' } } });
    const first = compileUntrustedSchema(schema());
    const sizeAfterFirst = untrustedSchemaCacheSize();
    const second = compileUntrustedSchema(schema());
    expect(second).toBe(first);
    expect(untrustedSchemaCacheSize()).toBe(sizeAfterFirst);
  });

  it('bounds the validator cache at 512 entries', () => {
    for (let index = 0; index < 600; index += 1) {
      compileUntrustedSchema({ type: 'object', properties: { [`p${index}`]: { type: 'string' } } });
    }
    expect(untrustedSchemaCacheSize()).toBe(512);
  });

  it('evicts the least recently used validator first', () => {
    const keep = (): Record<string, unknown> => ({ type: 'object', properties: { kept: { type: 'boolean' } } });
    const drop = (): Record<string, unknown> => ({ type: 'object', properties: { dropped: { type: 'boolean' } } });
    const kept = compileUntrustedSchema(keep());
    const dropped = compileUntrustedSchema(drop());
    for (let index = 0; index < 511; index += 1) {
      compileUntrustedSchema(keep());
      compileUntrustedSchema({ type: 'object', properties: { [`lru${index}`]: { type: 'number' } } });
    }
    expect(compileUntrustedSchema(keep())).toBe(kept);
    expect(compileUntrustedSchema(drop())).not.toBe(dropped);
  });

  it('caches a compile failure so each distinct bad schema is compiled at most once', () => {
    const bad = (): Record<string, unknown> => ({ type: 'object', properties: { broken: { type: 'cached-failure-type' } } });
    const before = untrustedSchemaCacheSize();
    let firstMessage = '';
    try {
      compileUntrustedSchema(bad());
    } catch (error) {
      firstMessage = (error as Error).message;
    }
    expect(firstMessage).not.toBe('');
    expect(untrustedSchemaCacheSize()).toBe(Math.min(512, before + 1));
    expect(() => compileUntrustedSchema(bad())).toThrow(firstMessage);
    expect(untrustedSchemaCacheSize()).toBe(Math.min(512, before + 1));
  });
});
