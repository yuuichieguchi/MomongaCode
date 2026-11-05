import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SchemaValidatorFailure, compileUntrustedSchema } from '@momonga/foundation';

const CYCLE_CODE = 'SCHEMA_REFERENCE_CYCLE';

const failureOf = (schema: Record<string, unknown>): unknown => {
  try {
    compileUntrustedSchema(schema);
  } catch (error) {
    return error;
  }
  return undefined;
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const expectCycleRefusal = (schema: Record<string, unknown>, pointers: readonly string[]): void => {
  const failure = failureOf(schema);
  expect(failure).toBeInstanceOf(SchemaValidatorFailure);
  const message = (failure as Error).message;
  expect(message).toContain(CYCLE_CODE);
  expect(message).toMatch(new RegExp(`"(${pointers.map(escapeRegExp).join('|')})"`));
};

const infiniteLoopDetectionSchema = (): Record<string, unknown> => {
  const url = new URL('./fixtures/json-schema-test-suite/tests/draft2020-12/infinite-loop-detection.json', import.meta.url);
  const cases = JSON.parse(readFileSync(url, 'utf8')) as { schema: Record<string, unknown> }[];
  return cases[0]!.schema;
};

describe('a reference cycle that never descends into the instance', () => {
  it.each([
    ['a schema that refers to itself', { $ref: '#' }, ['#/$ref']],
    ['a negated self reference', { not: { $ref: '#' } }, ['#/not/$ref']],
    ['a self reference under allOf', { allOf: [{ $ref: '#' }] }, ['#/allOf/0/$ref']],
    [
      'a cycle through anyOf, $defs and oneOf',
      { anyOf: [{ $ref: '#/$defs/a' }], $defs: { a: { oneOf: [{ $ref: '#' }] } } },
      ['#/anyOf/0/$ref', '#/$defs/a/oneOf/0/$ref'],
    ],
    ['a cycle through if and then', { if: { type: 'object' }, then: { $ref: '#' } }, ['#/then/$ref']],
    ['a cycle through if itself', { if: { $ref: '#' }, then: { type: 'object' } }, ['#/if/$ref']],
    ['a cycle through else', { if: { type: 'object' }, else: { allOf: [{ $ref: '#' }] } }, ['#/else/allOf/0/$ref']],
    ['a cycle through dependentSchemas', { dependentSchemas: { a: { $ref: '#' } } }, ['#/dependentSchemas/a/$ref']],
    [
      'a cycle through $dynamicRef',
      { $id: 'https://cycle.example/dynamic', $dynamicAnchor: 'node', anyOf: [{ $dynamicRef: '#node' }] },
      ['#/anyOf/0/$dynamicRef'],
    ],
    [
      'a two-schema cycle through $defs',
      { $ref: '#/$defs/a', $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } } },
      ['#/$defs/a/$ref', '#/$defs/b/$ref'],
    ],
    [
      'a two-schema cycle unreachable from the root',
      { type: 'object', $defs: { a: { not: { $ref: '#/$defs/b' } }, b: { allOf: [{ $ref: '#/$defs/a' }] } } },
      ['#/$defs/a/not/$ref', '#/$defs/b/allOf/0/$ref'],
    ],
  ])('refuses %s at load with the cycle code and its pointer', (_label, schema, pointers) => {
    expectCycleRefusal(schema, pointers);
  });

  it('refuses the same cycle on every compile', () => {
    const schema = { not: { $ref: '#' } };
    expectCycleRefusal(schema, ['#/not/$ref']);
    expectCycleRefusal(schema, ['#/not/$ref']);
  });
});

describe('recursion that descends into the instance', () => {
  it('accepts a tree whose children items refer to the root', () => {
    const validate = compileUntrustedSchema({
      type: 'object',
      properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#' } } },
      required: ['name'],
    });
    expect(validate({ name: 'a', children: [{ name: 'b', children: [{ name: 'c' }] }] })).toEqual({ valid: true });
    expect(validate({ name: 'a', children: [{ name: 'b', children: [{}] }] }).valid).toBe(false);
  });

  it('accepts a linked list whose next property refers to the root', () => {
    const validate = compileUntrustedSchema({
      type: 'object',
      properties: { value: { type: 'integer' }, next: { $ref: '#' } },
      required: ['value'],
    });
    expect(validate({ value: 1, next: { value: 2, next: { value: 3 } } })).toEqual({ valid: true });
    expect(validate({ value: 1, next: { value: 'two' } }).valid).toBe(false);
  });

  it.each([
    ['additionalProperties', { anyOf: [{ type: 'integer' }, { type: 'object', additionalProperties: { $ref: '#' } }] }, { a: { b: 1 } }, { a: { b: 'x' } }],
    ['patternProperties', { anyOf: [{ type: 'integer' }, { type: 'object', patternProperties: { '^n': { $ref: '#' } } }] }, { n1: { n2: 1 } }, { n1: { n2: 'x' } }],
    ['prefixItems', { anyOf: [{ type: 'integer' }, { type: 'array', prefixItems: [{ $ref: '#' }] }] }, [[1]], [['x']]],
    ['contains', { anyOf: [{ type: 'integer' }, { type: 'array', contains: { $ref: '#' } }] }, [[1]], [['x']]],
    ['unevaluatedProperties', { anyOf: [{ type: 'integer' }, { type: 'object', unevaluatedProperties: { $ref: '#' } }] }, { a: 1 }, { a: 'x' }],
    ['unevaluatedItems', { anyOf: [{ type: 'integer' }, { type: 'array', unevaluatedItems: { $ref: '#' } }] }, [1, [2]], [1, ['x']]],
    ['propertyNames', { type: ['object', 'string'], propertyNames: { $ref: '#' } }, { a: 'b' }, 1],
  ])('accepts recursion that descends through %s', (_label, schema, valid, invalid) => {
    const validate = compileUntrustedSchema(schema);
    expect(validate(valid)).toEqual({ valid: true });
    expect(validate(invalid).valid).toBe(false);
  });

  it('accepts a reference into $defs without a cycle', () => {
    const validate = compileUntrustedSchema({ $defs: { a: { type: 'string' } }, $ref: '#/$defs/a' });
    expect(validate('x')).toEqual({ valid: true });
    expect(validate(1).valid).toBe(false);
  });

  it('accepts the same schema location visited twice without a cycle', () => {
    const validate = compileUntrustedSchema(infiniteLoopDetectionSchema());
    expect(validate({ foo: 1 })).toEqual({ valid: true });
    expect(validate({ foo: 'a string' }).valid).toBe(false);
  });
});
