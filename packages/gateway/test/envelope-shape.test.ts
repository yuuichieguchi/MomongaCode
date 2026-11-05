import { describe, expect, it } from 'vitest';
import { PROBE_KEYWORDS } from '@momonga/protocol';
import { buildToolsEnvelope } from '../src/probe/envelope.ts';

const SUPPORT_ALL = Object.fromEntries(PROBE_KEYWORDS.map((keyword) => [keyword, true])) as Parameters<typeof buildToolsEnvelope>[1];

const TOOLS = [
  { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'list', parameters: { type: 'object', properties: {} } },
];

const envelopeOf = (shape: 'union' | 'flat') =>
  buildToolsEnvelope(TOOLS, SUPPORT_ALL, false, 'json-schema-2020-12', shape);

describe('envelopeAround follows the recorded shape, not support.anyOf (rule 4)', () => {
  it('builds the flat envelope when the record says flat, although anyOf is supported', () => {
    const envelope = envelopeOf('flat');
    expect(envelope).not.toHaveProperty('anyOf');
    expect(Object.keys(envelope['properties'] as object).sort()).toEqual(['calls', 'kind', 'text']);
    expect(envelope['required']).toEqual(['kind']);
  });

  it('builds the union envelope when the record says union', () => {
    const envelope = envelopeOf('union');
    expect(Array.isArray(envelope['anyOf'])).toBe(true);
    expect((envelope['anyOf'] as unknown[]).length).toBe(2);
  });
});
