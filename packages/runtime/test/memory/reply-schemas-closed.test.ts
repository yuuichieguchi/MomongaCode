import { describe, expect, it } from 'vitest';
import { isRecord } from '@momonga/foundation';
import { CLASSIFIER_VERDICT_SCHEMA } from '@momonga/protocol';
import { REFLECTION_REPLY_SCHEMA } from '../../src/memory/reflection-reply.ts';

const objectNodes = (schema: unknown): Record<string, unknown>[] => {
  if (Array.isArray(schema)) return schema.flatMap(objectNodes);
  if (!isRecord(schema)) return [];
  const own = schema['type'] === 'object' ? [schema] : [];
  return [...own, ...Object.values(schema).flatMap(objectNodes)];
};

describe.each([
  ['the reflection reply', REFLECTION_REPLY_SCHEMA],
  ['the classifier verdict', CLASSIFIER_VERDICT_SCHEMA],
])('%s schema has no optional property at any level', (_label, schema) => {
  it('closes every object and requires every property', () => {
    const nodes = objectNodes(schema);
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node['additionalProperties']).toBe(false);
      const properties = isRecord(node['properties']) ? Object.keys(node['properties']) : [];
      const required = Array.isArray(node['required']) ? [...node['required']].sort() : [];
      expect(required).toEqual([...properties].sort());
    }
  });
});
