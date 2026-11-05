import { describe, expect, it } from 'vitest';
import { PROBE_KEYWORDS } from '@momonga/protocol';
import { withKeywordSupport } from '../src/dialect/choice.ts';
import type { KeywordSupport } from '../src/dialect/keyword-support.ts';
import { renderSchema } from '../src/dialect/render.ts';

const lowerSchema = (schema: unknown, support: KeywordSupport): unknown => renderSchema(schema, { kind: 'probe' }, withKeywordSupport('json-schema-2020-12', support)).schema;

const supportAll = Object.fromEntries(PROBE_KEYWORDS.map((keyword) => [keyword, true])) as KeywordSupport;
const without = (...keywords: Array<keyof KeywordSupport>): KeywordSupport => ({
  ...supportAll,
  ...Object.fromEntries(keywords.map((keyword) => [keyword, false])),
});

describe('keyword table rules, enum and const lowering', () => {
  it('derives the type from string literals', () => {
    expect(lowerSchema({ enum: ['a', 'b'] }, without('enum'))).toEqual({ type: 'string' });
    expect(lowerSchema({ const: 'a' }, without('const'))).toEqual({ type: 'string' });
  });

  it('derives integer, number, boolean and null types', () => {
    expect(lowerSchema({ enum: [1, 2] }, without('enum'))).toEqual({ type: 'integer' });
    expect(lowerSchema({ enum: [1, 2.5] }, without('enum'))).toEqual({ type: 'number' });
    expect(lowerSchema({ const: true }, without('const'))).toEqual({ type: 'boolean' });
    expect(lowerSchema({ const: null }, without('const'))).toEqual({ type: 'null' });
  });

  it('derives a type array for mixed literals', () => {
    expect(lowerSchema({ enum: ['a', 1, null] }, without('enum'))).toEqual({ type: ['string', 'integer', 'null'] });
  });

  it('keeps an explicit type', () => {
    expect(lowerSchema({ type: 'integer', enum: [1, 2] }, without('enum'))).toEqual({ type: 'integer' });
  });

  it('keeps enum and const when they are supported', () => {
    expect(lowerSchema({ enum: [1, 2] }, supportAll)).toEqual({ enum: [1, 2] });
    expect(lowerSchema({ const: 1 }, supportAll)).toEqual({ const: 1 });
  });

  it('lowers enums nested in properties', () => {
    expect(lowerSchema({ type: 'object', properties: { level: { enum: [1, 2, 3] } } }, without('enum'))).toEqual({
      type: 'object',
      properties: { level: { type: 'integer' } },
    });
  });
});

describe('keyword table rules, nested object lowering', () => {
  const objectSchema = { type: 'object', properties: { inner: { type: 'string' } } };

  it('flattens object properties', () => {
    expect(lowerSchema({ type: 'object', properties: { a: objectSchema } }, without('nested'))).toEqual({
      type: 'object',
      properties: { a: { type: 'object' } },
    });
  });

  it('flattens object schemas under items', () => {
    expect(lowerSchema({ type: 'array', items: objectSchema }, without('nested'))).toEqual({
      type: 'array',
      items: { type: 'object' },
    });
  });

  it.each(['anyOf', 'allOf'])('flattens object schemas inside %s branches', (keyword) => {
    expect(lowerSchema({ [keyword]: [objectSchema, { type: 'string' }] }, without('nested'))).toEqual({
      [keyword]: [{ type: 'object' }, { type: 'string' }],
    });
  });

  it('leaves object schemas inside oneOf branches as they are, because oneOf is a mixed position and a drop there would change what the schema accepts in both directions', () => {
    const schema = { oneOf: [objectSchema, { type: 'string' }] };
    expect(lowerSchema(schema, without('nested'))).toEqual(schema);
  });

  it('flattens an object schema under additionalProperties', () => {
    expect(lowerSchema({ type: 'object', additionalProperties: objectSchema }, without('nested'))).toEqual({
      type: 'object',
      additionalProperties: { type: 'object' },
    });
  });

  it('keeps nested objects when nesting is supported', () => {
    const schema = { type: 'array', items: objectSchema };
    expect(lowerSchema(schema, supportAll)).toEqual(schema);
  });
});
