import { describe, expect, it } from 'vitest';
import { validateUntrusted } from '@momonga/foundation';

const errorsOf = (schema: Record<string, unknown>, data: unknown) => {
  const verdict = validateUntrusted('nested-tags', schema, data);
  if (verdict.valid) throw new Error('expected the instance to be invalid');
  return verdict.errors.map(({ instancePath, keyword, message, params }) => ({ instancePath, keyword, message, params }));
};

const LEAF = { type: 'object', properties: { kind: { const: 'leaf' }, n: { type: 'integer' } }, required: ['kind', 'n'] };
const X = { type: 'object', properties: { kind: { const: 'x' }, s: { type: 'string' } }, required: ['kind', 's'] };
const Y = { type: 'object', properties: { kind: { const: 'y' }, b: { type: 'boolean' } }, required: ['kind', 'b'] };
const Y_BY_ENUM = { type: 'object', properties: { kind: { enum: ['y'] }, b: { type: 'boolean' } }, required: ['kind', 'b'] };

describe('the error mapping sees tags through nested unions', () => {
  it('(a) selects by a tag held inside a nested anyOf', () => {
    const schema = { oneOf: [LEAF, { anyOf: [X, Y] }] };
    expect(errorsOf(schema, { kind: 'y', b: 'no' })).toEqual([{ instancePath: '/b', keyword: 'type', message: 'must be boolean', params: { type: 'boolean' } }]);
  });

  it('(b) selects by a tag reached through $ref, both to the nested union and to its variant', () => {
    const schema = {
      $defs: { Pair: { oneOf: [X, { $ref: '#/$defs/Y' }] }, Y },
      oneOf: [LEAF, { $ref: '#/$defs/Pair' }],
    };
    expect(errorsOf(schema, { kind: 'y', b: 'no' })).toEqual([{ instancePath: '/b', keyword: 'type', message: 'must be boolean', params: { type: 'boolean' } }]);
  });

  it('(c) treats a const tag and a one-value enum tag as the same key', () => {
    const schema = { oneOf: [LEAF, { anyOf: [X, Y_BY_ENUM] }] };
    expect(errorsOf(schema, { kind: 'y', b: 'no' })).toEqual([{ instancePath: '/b', keyword: 'type', message: 'must be boolean', params: { type: 'boolean' } }]);
    expect(errorsOf(schema, { kind: 'zzz' })).toEqual([
      { instancePath: '/kind', keyword: 'enum', message: 'must be equal to one of the allowed values', params: { allowedValues: ['leaf', 'x', 'y'] } },
    ]);
  });

  it('(d) drops a key that one nested variant does not tag, and falls back to depth', () => {
    const DEEP_LEAF = { type: 'object', properties: { kind: { const: 'leaf' }, n: { type: 'object', properties: { m: { type: 'integer' } } } }, required: ['kind'] };
    const schema = { oneOf: [DEEP_LEAF, { anyOf: [X, { type: 'string' }] }] };
    expect(errorsOf(schema, { kind: 'x', n: { m: 'q' } })).toEqual([
      { instancePath: '/kind', keyword: 'const', message: 'must be equal to constant', params: { allowedValue: 'leaf' } },
      { instancePath: '/n/m', keyword: 'type', message: 'must be integer', params: { type: 'integer' } },
    ]);
  });

  it('(e) terminates on a $ref cycle A -> B -> oneOf[$ref A] with a deterministic message', () => {
    const schema = {
      $defs: {
        A: { $ref: '#/$defs/B' },
        B: { oneOf: [{ $ref: '#/$defs/A' }, { type: 'object', properties: { kind: { const: 'z' }, v: { type: 'integer' } }, required: ['kind'] }] },
      },
      oneOf: [{ type: 'object', properties: { kind: { const: 'leaf' } }, required: ['kind'] }, { $ref: '#/$defs/A' }],
    };
    const expected = [{ instancePath: '/kind', keyword: 'const', message: 'must be equal to constant', params: { allowedValue: 'leaf' } }];
    expect(errorsOf(schema, { kind: 'z' })).toEqual(expected);
    expect(errorsOf(schema, { kind: 'z' })).toEqual(expected);
  });
});
