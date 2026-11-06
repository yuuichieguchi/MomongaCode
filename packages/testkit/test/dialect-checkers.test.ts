import { describe, expect, it } from 'vitest';
import { inlinedSubsetRefusalOf, strictClosedRefusalOf } from '@momonga/testkit';

const closed = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
  ...extra,
});

describe('the strict-closed checker, written from pi constrained-sampling.ts:15-32 and :116-123, not measured on a server', () => {
  it('accepts a closed object whose every property is required', () => {
    expect(strictClosedRefusalOf(closed({ path: { type: 'string' }, limit: { type: 'integer' } }))).toBeUndefined();
  });

  it('accepts null for a wrapped optional property that is required', () => {
    expect(strictClosedRefusalOf(closed({ path: { type: 'string' }, limit: { anyOf: [{ type: 'integer' }, { type: 'null' }] } }))).toBeUndefined();
  });

  it('accepts a nested closed object and closed array items', () => {
    expect(strictClosedRefusalOf(closed({ inner: closed({ a: { type: 'string' } }), list: { type: 'array', items: closed({ b: { type: 'boolean' } }) } }))).toBeUndefined();
  });

  it('refuses a property missing from required, naming it', () => {
    const refusal = strictClosedRefusalOf({ type: 'object', properties: { path: { type: 'string' }, limit: { type: 'integer' } }, required: ['path'], additionalProperties: false });
    expect(refusal).toEqual(expect.stringContaining('limit'));
  });

  it('refuses a missing property of a nested object, naming it', () => {
    const refusal = strictClosedRefusalOf(closed({ inner: { type: 'object', properties: { deep: { type: 'string' } }, required: [], additionalProperties: false } }));
    expect(refusal).toEqual(expect.stringContaining('deep'));
  });

  it.each([
    ['absent', {}],
    ['true', { additionalProperties: true }],
    ['a schema', { additionalProperties: { type: 'string' } }],
  ])('refuses an object whose additionalProperties is %s', (_label, extra) => {
    const { additionalProperties: _dropped, ...open } = closed({ a: { type: 'string' } });
    expect(strictClosedRefusalOf({ ...open, ...extra })).toEqual(expect.stringContaining('additionalProperties'));
  });

  it.each([
    ['$ref', '#/$defs/x'],
    ['allOf', [{}]],
    ['oneOf', [{}]],
    ['patternProperties', {}],
    ['not', {}],
    ['if', {}],
  ])('refuses the keyword %s', (keyword, value) => {
    expect(strictClosedRefusalOf(closed({ a: { type: 'string', [keyword]: value } }))).toEqual(expect.stringContaining(keyword));
  });
});

describe('the inlined-subset checker, written from Hermes gemini_schema.py:179-198 and OpenCode gemini-json-schema.ts:28-29, not measured on a server', () => {
  it('accepts an inlined object whose required names are declared', () => {
    expect(inlinedSubsetRefusalOf({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'integer' } }, required: ['a'] })).toBeUndefined();
  });

  it('accepts an empty parameters object with properties', () => {
    expect(inlinedSubsetRefusalOf({ type: 'object', properties: {} })).toBeUndefined();
  });

  it('refuses a required name that is not a declared property, naming it', () => {
    expect(inlinedSubsetRefusalOf({ type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'ghost'] })).toEqual(expect.stringContaining('ghost'));
  });

  it.each([
    ['$ref', { type: 'object', properties: { a: { $ref: '#/$defs/x' } }, $defs: { x: { type: 'string' } } }],
    ['$defs', { type: 'object', properties: {}, $defs: { x: { type: 'string' } } }],
    ['definitions', { type: 'object', properties: {}, definitions: { x: { type: 'string' } } }],
    ['$schema', { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {} }],
  ])('refuses %s', (keyword, parameters) => {
    expect(inlinedSubsetRefusalOf(parameters)).toEqual(expect.stringContaining(keyword));
  });

  it('refuses tool parameters without a properties map', () => {
    expect(inlinedSubsetRefusalOf({ type: 'object' })).toEqual(expect.stringContaining('properties'));
  });
});
