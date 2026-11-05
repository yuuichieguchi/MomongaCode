import { describe, expect, it } from 'vitest';
import { validateUntrusted } from '@momonga/foundation';

const errorsOf = (schema: Record<string, unknown>, data: unknown) => {
  const verdict = validateUntrusted('error-mapping', schema, data);
  if (verdict.valid) throw new Error('expected the instance to be invalid');
  return verdict.errors.map(({ instancePath, keyword, message }) => ({ instancePath, keyword, message }));
};

const TAGGED = {
  type: 'object',
  properties: {
    input: {
      type: 'array',
      items: {
        oneOf: [
          { type: 'object', properties: { type: { const: 'message' }, content: { type: 'string' } }, required: ['type', 'content'] },
          { type: 'object', properties: { type: { const: 'function_call_output' }, call_id: { type: 'string' }, output: { type: 'string' } }, required: ['type', 'call_id', 'output'] },
        ],
      },
    },
  },
};

describe('the error mapping at the untrusted-schema boundary', () => {
  it('reports the failing branch of an anyOf instead of the variant count', () => {
    const schema = { type: 'object', properties: { model: { anyOf: [{ type: 'string' }, { type: 'null' }] } } };
    expect(errorsOf(schema, { model: 3 })).toEqual([{ instancePath: '/model', keyword: 'type', message: 'must be string' }]);
  });

  it('reports the branch whose tag matches the instance for a oneOf', () => {
    expect(errorsOf(TAGGED, { input: [{ type: 'function_call_output', call_id: 'c', output: 5 }] })).toEqual([
      { instancePath: '/input/0/output', keyword: 'type', message: 'must be string' },
    ]);
  });

  it('picks the tagged branch even when another branch has fewer or milder errors', () => {
    const schema = {
      type: 'object',
      properties: { x: { $ref: '#/$defs/u' } },
      $defs: {
        u: {
          oneOf: [
            { type: 'object', properties: { t: { const: 'a' }, v: { type: 'string' } }, required: ['t'] },
            { type: 'object', properties: { t: { const: 'b' }, w: { type: 'integer' } }, required: ['t'] },
          ],
        },
      },
    };
    expect(errorsOf(schema, { x: { t: 'b', w: 'q' } })).toEqual([{ instancePath: '/x/w', keyword: 'type', message: 'must be integer' }]);
  });

  it('without a matching tag reports the branch whose error is deepest, then the one with fewest errors', () => {
    const schema = {
      anyOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] },
        { type: 'object', properties: { a: { type: 'object', properties: { c: { type: 'integer' } } } } },
      ],
    };
    expect(errorsOf(schema, { a: { c: 'x' } })).toEqual([{ instancePath: '/a/c', keyword: 'type', message: 'must be integer' }]);
  });

  it('orders errors by instance path in document order, parents first, then keyword, whatever the engine order is', () => {
    const schema = {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'integer' } }, name: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    };
    const errors = errorsOf(schema, { items: [1, 'x', 'y', 4, 5, 6, 7, 8, 9, 10, 'z'], name: 1, extra: true });
    expect(errors.map(({ instancePath, keyword }) => `${instancePath}|${keyword}`)).toEqual([
      '|additionalProperties',
      '|required',
      '/items/1|type',
      '/items/2|type',
      '/items/10|type',
      '/name|type',
    ]);
  });
});
