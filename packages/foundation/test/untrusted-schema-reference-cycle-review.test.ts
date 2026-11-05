import { describe, expect, it } from 'vitest';
import { SchemaValidatorFailure, ataEngine, compileUntrustedSchema, createUntrustedBoundary } from '@momonga/foundation';

const CYCLE_CODE = 'SCHEMA_REFERENCE_CYCLE';
const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';
const REMOTE = 'https://remote.example/cycles.json';

type Compile = (schema: Record<string, unknown>) => unknown;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const failureOf = (compile: Compile, schema: Record<string, unknown>): unknown => {
  try {
    compile(schema);
  } catch (error) {
    return error;
  }
  return undefined;
};

const expectCycleRefusal = (compile: Compile, schema: Record<string, unknown>, pointers: readonly string[]): void => {
  const failure = failureOf(compile, schema);
  expect(failure).toBeInstanceOf(SchemaValidatorFailure);
  const message = (failure as Error).message;
  expect(message).toContain(CYCLE_CODE);
  expect(message).toMatch(new RegExp(`"(${pointers.map(escapeRegExp).join('|')})"`));
};

const expectVerdicts = (schema: Record<string, unknown>, valid: unknown, invalid: unknown): void => {
  const validate = compileUntrustedSchema(schema);
  expect(validate(valid)).toEqual({ valid: true });
  expect(validate(invalid).valid).toBe(false);
};

const remoteBoundary = () =>
  createUntrustedBoundary({
    remotes: new Map([[REMOTE, { $defs: { loop: { not: { $ref: '#/$defs/loop' } }, ok: { type: 'string' } } }]]),
    engine: ataEngine,
  });

const EMBEDDED = 'https://remote.example/inner.json';

const embeddedBoundary = (inner: Record<string, unknown>) =>
  createUntrustedBoundary({
    remotes: new Map([['https://remote.example/outer.json', { $defs: { inner: { $id: EMBEDDED, ...inner } } }]]),
    engine: ataEngine,
  });

describe('cycles the checker must refuse', () => {
  it.each([
    ['a reference into an unindexed location that refers back to the root', { x: { $ref: '#' }, $ref: '#/x' }, ['#/x/$ref', '#/$ref']],
    ['an unindexed location that refers to itself', { x: { allOf: [{ $ref: '#/x' }] }, $ref: '#/x' }, ['#/x/allOf/0/$ref']],
    [
      'a $dynamicRef cycle entered from a $defs location',
      {
        $id: 'https://dynamic.example/root',
        $ref: 'c',
        $defs: {
          a: { $id: 'a', $dynamicAnchor: 'x' },
          b: { $id: 'b', $dynamicAnchor: 'x', not: { $ref: 'c' } },
          c: { $id: 'c', $dynamicRef: 'a#x' },
        },
      },
      ['#/$defs/b/not/$ref', '#/$defs/c/$dynamicRef'],
    ],
    ['a draft-07 definitions self-cycle', { $schema: DRAFT_07, definitions: { a: { allOf: [{ $ref: '#/definitions/a' }] } } }, ['#/definitions/a/allOf/0/$ref']],
    ['a draft-07 plain-name $id anchor in a cycle', { $schema: DRAFT_07, definitions: { a: { $id: '#foo', not: { $ref: '#foo' } } } }, ['#/definitions/a/not/$ref']],
    ['a draft-07 dependencies cycle', { $schema: DRAFT_07, dependencies: { a: { $ref: '#' } } }, ['#/dependencies/a/$ref']],
    ['a cycle through an $anchor', { $defs: { a: { $anchor: 'loop', anyOf: [{ $ref: '#loop' }] } } }, ['#/$defs/a/anyOf/0/$ref']],
    ['a cycle through an embedded $id that changes the base', { $id: 'https://embedded.example/root', $defs: { a: { $id: 'inner', allOf: [{ $ref: 'inner' }] } } }, ['#/$defs/a/allOf/0/$ref']],
    ['a cycle under a key with a slash', { $defs: { 'a/b': { not: { $ref: '#/$defs/a~1b' } } } }, ['#/$defs/a~1b/not/$ref']],
    ['a cycle under a key with a space', { $defs: { 'a b': { not: { $ref: '#/$defs/a%20b' } } } }, ['#/$defs/a%20b/not/$ref']],
  ])('refuses %s', (_label, schema, pointers) => {
    expectCycleRefusal(compileUntrustedSchema, schema, pointers);
  });

  it('refuses a schema whose reference enters a cycle in a remote document, naming the remote pointer', () => {
    const boundary = remoteBoundary();
    expectCycleRefusal(boundary.compile, { $ref: `${REMOTE}#/$defs/loop` }, [`${REMOTE}#/$defs/loop/not/$ref`]);
  });
});

describe('resources embedded in a remote document that is not yet entered', () => {
  it('refuses a reference to an embedded resource whose subschema cycles, labelling the pointer with that resource', () => {
    const boundary = embeddedBoundary({ $defs: { loop: { not: { $ref: '#/$defs/loop' } } } });
    expectCycleRefusal(boundary.compile, { $ref: `${EMBEDDED}#/$defs/loop` }, [`${EMBEDDED}#/$defs/loop/not/$ref`]);
  });

  it('refuses a reference through an $anchor inside the embedded resource', () => {
    const boundary = embeddedBoundary({ $defs: { loop: { $anchor: 'loop', anyOf: [{ $ref: '#loop' }] } } });
    expectCycleRefusal(boundary.compile, { $ref: `${EMBEDDED}#loop` }, [`${EMBEDDED}#/$defs/loop/anyOf/0/$ref`]);
  });

  it('refuses a reference to the embedded resource itself', () => {
    const boundary = embeddedBoundary({ not: { $ref: EMBEDDED } });
    expectCycleRefusal(boundary.compile, { $ref: EMBEDDED }, [`${EMBEDDED}#/not/$ref`]);
  });
});

describe('schemas the checker must accept', () => {
  it('accepts a schema that never references the cycle in a remote document', () => {
    const boundary = remoteBoundary();
    expect(boundary.validate('remote-ok', { type: 'object', properties: { a: { $ref: `${REMOTE}#/$defs/ok` } } }, { a: 'x' })).toEqual({ valid: true });
    expect(boundary.validate('remote-ok', { type: 'object', properties: { a: { $ref: `${REMOTE}#/$defs/ok` } } }, { a: 1 }).valid).toBe(false);
    expect(boundary.validate('remote-plain', { type: 'object' }, {})).toEqual({ valid: true });
  });

  it('accepts the 2020-12 strict-tree extension through $dynamicRef', () => {
    expectVerdicts(
      {
        $id: 'https://example.com/strict-tree',
        $dynamicAnchor: 'node',
        $ref: 'tree',
        unevaluatedProperties: false,
        $defs: {
          tree: {
            $id: 'https://example.com/tree',
            $dynamicAnchor: 'node',
            type: 'object',
            properties: { data: true, children: { type: 'array', items: { $dynamicRef: '#node' } } },
          },
        },
      },
      { children: [{ data: 1 }] },
      { children: [{ daat: 1 }] },
    );
  });

  it('accepts a draft-07 cycle that runs only through a $ref sibling the dialect ignores', () => {
    expectVerdicts({ $schema: DRAFT_07, $ref: '#/definitions/s', allOf: [{ $ref: '#' }], definitions: { s: { type: 'integer' } } }, 1, 'x');
  });

  it('accepts draft-07 recursion through array-form items', () => {
    expectVerdicts({ $schema: DRAFT_07, anyOf: [{ type: 'integer' }, { type: 'array', items: [{ $ref: '#' }] }] }, [[1]], [['x']]);
  });

  it('accepts references to boolean schemas', () => {
    expectVerdicts({ type: 'integer', $defs: { t: true }, $ref: '#/$defs/t' }, 1, 'x');
  });

  it('accepts a reference to a false schema under a property', () => {
    expectVerdicts({ type: 'object', properties: { a: { $ref: '#/$defs/f' } }, $defs: { f: false } }, {}, { a: 1 });
  });
});
