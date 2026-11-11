import { describe, expect, it } from 'vitest';
import { MAX_SCHEMA_BYTES, SchemaRejectedError, boundedSchemaCopy } from '../src/schema-copy.ts';

describe('the copy of a schema a server sent', () => {
  it('is deep: a change to any part of the copy does not reach what the server sent', () => {
    const sent = {
      type: 'object',
      properties: { colour: { type: 'string', enum: ['red', 'green'], default: { nested: ['kept'] } } },
      required: ['colour'],
      examples: [{ colour: 'red' }],
    };
    const before = structuredClone(sent);

    const copy = boundedSchemaCopy(sent) as typeof sent;
    expect(copy).toEqual(before);
    copy.properties.colour.enum.push('blue');
    copy.properties.colour.default.nested.push('added');
    copy.required.push('other');
    (copy.examples[0] as { colour: string }).colour = 'changed';

    expect(sent).toEqual(before);
  });

  it('refuses a schema over the size limit and names the limit', () => {
    const oversize = { type: 'object', description: 'x'.repeat(MAX_SCHEMA_BYTES) };

    expect(() => boundedSchemaCopy(oversize)).toThrow(SchemaRejectedError);
    expect(() => boundedSchemaCopy(oversize)).toThrow(`over the ${MAX_SCHEMA_BYTES / 1024} KiB limit`);
  });

  it('copies a schema at the size limit', () => {
    const overhead = Buffer.byteLength(JSON.stringify({ description: '', type: 'object' }));
    const atLimit = { type: 'object', description: 'x'.repeat(MAX_SCHEMA_BYTES - overhead) };

    expect(boundedSchemaCopy(atLimit)).toEqual(atLimit);
  });
});
