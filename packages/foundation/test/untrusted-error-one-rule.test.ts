import { describe, expect, it } from 'vitest';
import { validateUntrusted } from '@momonga/foundation';

const errorsOf = (schema: Record<string, unknown>, data: unknown) => {
  const verdict = validateUntrusted('one-rule', schema, data);
  if (verdict.valid) throw new Error('expected the instance to be invalid');
  return verdict.errors.map(({ instancePath, keyword, message }) => ({ instancePath, keyword, message }));
};

describe('the error mapping chooses a branch by its tag, otherwise by depth, and reports every error of the chosen branch', () => {
  it('reports a missing property and a deeper type error together for an untagged union', () => {
    const schema = {
      anyOf: [
        { type: 'object', properties: { a: { type: 'object', properties: { c: { type: 'integer' } } } }, required: ['b'] },
        { type: 'string' },
      ],
    };
    expect(errorsOf(schema, { a: { c: 'x' } })).toEqual([
      { instancePath: '', keyword: 'required', message: "must have required property 'b'" },
      { instancePath: '/a/c', keyword: 'type', message: 'must be integer' },
    ]);
  });

  const TAGGED = {
    type: 'object',
    properties: {
      event: {
        oneOf: [
          { type: 'object', properties: { type: { const: 'a' }, x: { type: 'string' } }, required: ['type', 'x'] },
          { type: 'object', properties: { type: { const: 'b' }, y: { type: 'integer' } }, required: ['type', 'y'] },
        ],
      },
    },
  };

  it('reports every error of the branch whose tag matches', () => {
    expect(errorsOf(TAGGED, { event: { type: 'b', y: 'q', z: 1 } })).toEqual([{ instancePath: '/event/y', keyword: 'type', message: 'must be integer' }]);
    expect(errorsOf(TAGGED, { event: { type: 'a', x: 1 } })).toEqual([{ instancePath: '/event/x', keyword: 'type', message: 'must be string' }]);
  });

  it('reports the tag property alone when no branch tag matches', () => {
    expect(errorsOf(TAGGED, { event: { type: 'zzz', x: 1 } })).toEqual([{ instancePath: '/event/type', keyword: 'enum', message: 'must be equal to one of the allowed values' }]);
  });

  it('names the allowed tags of the unknown-tag error', () => {
    const verdict = validateUntrusted('one-rule', TAGGED, { event: { type: 'zzz' } });
    if (verdict.valid) throw new Error('expected the instance to be invalid');
    expect(verdict.errors[0]?.params).toEqual({ allowedValues: ['a', 'b'] });
  });

  it('reports the missing tag property when the instance has no tag', () => {
    expect(errorsOf(TAGGED, { event: { x: 'q' } })).toEqual([{ instancePath: '/event', keyword: 'required', message: "must have required property 'type'" }]);
  });
});
