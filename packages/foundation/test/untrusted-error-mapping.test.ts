import { describe, expect, it } from 'vitest';
import { ataEngine, createUntrustedBoundary, validateUntrusted } from '@momonga/foundation';
import type { Engine } from '@momonga/foundation';

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

describe('the error mapping on a recursive schema', () => {
  const TREE = {
    $ref: '#/$defs/node',
    $defs: {
      node: {
        anyOf: [
          { type: 'object', properties: { kind: { const: 'leaf' }, v: { type: 'number' } }, required: ['kind', 'v'] },
          { type: 'object', properties: { kind: { const: 'branch' }, kids: { type: 'array', items: { $ref: '#/$defs/node' } } }, required: ['kind', 'kids'] },
        ],
      },
    },
  };

  it('reports the failing leaf inside a branch, with every level keeping its full anyOf', () => {
    expect(errorsOf(TREE, { kind: 'branch', kids: [{ kind: 'leaf', v: 'x' }] })).toEqual([{ instancePath: '/kids/0/v', keyword: 'type', message: 'must be number' }]);
  });
});

describe('the work the error mapping does', () => {
  const branch = (kind: string) => ({ type: 'object', properties: { kind: { const: kind }, data: { type: 'array', items: { type: 'string' } } }, required: ['kind', 'data'] });
  const SCHEMA = {
    type: 'object',
    properties: {
      msg: { anyOf: [branch('a'), branch('b'), branch('c'), branch('d'), branch('e')] },
      extra: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] },
    },
  };

  it('runs the engine once on the body and once per branch on the failing sub-instance only', () => {
    const invoked: unknown[] = [];
    const engine: Engine = {
      compile: (schema, registry) => {
        const validate = ataEngine.compile(schema, registry);
        return (instance) => {
          invoked.push(instance);
          return validate(instance);
        };
      },
    };
    const validate = createUntrustedBoundary({ remotes: new Map(), engine }).compile(SCHEMA);
    const body = { msg: { kind: 'zz', data: ['x'] }, extra: {} };
    invoked.length = 0;
    const verdict = validate(body);
    expect(verdict.valid).toBe(false);
    expect(invoked.filter((instance) => instance === body)).toHaveLength(1);
    expect(invoked).toHaveLength(1 + 5 + 4);
    expect(invoked.filter((instance) => instance === body.msg)).toHaveLength(5);
    expect(invoked.filter((instance) => instance === body.extra)).toHaveLength(4);
  });

  it('always reports at least one error for an invalid verdict', () => {
    const verdict = validateUntrusted('work', SCHEMA, { msg: 1, extra: {} });
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.errors.length).toBeGreaterThan(0);
  });

  it('maps a draft-07 schema through its original pointers', () => {
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      definitions: { s: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
      properties: { model: { $ref: '#/definitions/s' } },
    };
    expect(errorsOf(schema, { model: 3 })).toEqual([{ instancePath: '/model', keyword: 'type', message: 'must be string' }]);
  });
});

describe('the work the error mapping does on a recursive schema with two branches', () => {
  const DEPTH = 30;
    const RECURSIVE = {
    $ref: '#/$defs/node',
    $defs: {
      node: {
        anyOf: [
          { type: 'object', properties: { c: { $ref: '#/$defs/node' } } },
          { type: 'object', properties: { d: { $ref: '#/$defs/node' } } },
        ],
      },
    },
  };

  it('probes each branch once per level along the winning path, linear in depth times branches', () => {
    let calls = 0;
    const engine: Engine = {
      compile: (schema, registry) => {
        const validate = ataEngine.compile(schema, registry);
        return (instance) => {
          calls += 1;
          return validate(instance);
        };
      },
    };
    const validate = createUntrustedBoundary({ remotes: new Map(), engine }).compile(RECURSIVE);
    let instance: unknown = 'x';
    for (let level = 0; level < DEPTH; level += 1) instance = { c: instance, d: 'y' };
    calls = 0;
    const verdict = validate(instance);
    expect(verdict.valid).toBe(false);
    expect(calls).toBeLessThanOrEqual(1 + 2 * (DEPTH + 1));
    if (!verdict.valid) expect(verdict.errors.length).toBeGreaterThan(0);
  });
});

describe('the error mapping on a schema that names its own root by the engine base', () => {
  it('reports the failing branch of an anyOf whose branch refers to the root by ata://root', () => {
    const schema = {
      $defs: { a: { type: 'object', properties: { n: { type: 'number' } } } },
      properties: { p: { anyOf: [{ $ref: 'ata://root#/$defs/a' }, { type: 'string' }] } },
    };
    expect(errorsOf(schema, { p: { n: 'x' } })).toEqual([{ instancePath: '/p/n', keyword: 'type', message: 'must be number' }]);
  });

  it('gives the root no second name: a reference to the former synthetic root id is unresolvable', () => {
    const schema = { $defs: { a: { type: 'number' } }, properties: { p: { anyOf: [{ $ref: 'urn:momonga:untrusted-root#/$defs/a' }, { type: 'string' }] } } };
    expect(() => validateUntrusted('error-mapping', schema, { p: true })).toThrow('cannot be resolved');
  });
});
