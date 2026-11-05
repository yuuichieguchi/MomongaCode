import { describe, expect, it } from 'vitest';
import { SchemaValidatorFailure, ataEngine, createUntrustedBoundary, validateUntrusted } from '@momonga/foundation';

const REMOTE = 'https://remote.example/item.json';

describe('references and dialects at the untrusted-schema boundary', () => {
  it.each([
    ['a remote $ref nobody supplied', { type: 'object', properties: { a: { $ref: 'https://example.invalid/x.json' } } }],
    ['a local pointer that names nothing', { type: 'object', properties: { a: { $ref: '#/$defs/missing' } } }],
    ['a local anchor that names nothing', { type: 'object', properties: { a: { $ref: '#nothing' } } }],
    ['a draft-04 $schema', { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object' }],
    ['a 2019-09 $schema', { $schema: 'https://json-schema.org/draft/2019-09/schema', type: 'object' }],
    ['a schema that is not valid', { type: 'object', properties: { a: { type: 'strin' } } }],
  ])('refuses %s at compile time', (_label, schema) => {
    expect(() => validateUntrusted('refs', schema, {})).toThrow(SchemaValidatorFailure);
  });

  it('names the unresolved reference in the failure', () => {
    expect(() => validateUntrusted('refs', { type: 'object', properties: { a: { $ref: 'https://example.invalid/x.json' } } }, {})).toThrow(
      'https://example.invalid/x.json',
    );
  });

  it('resolves a reference only against the documents given at construction', () => {
    const schema = { type: 'object', properties: { a: { $ref: REMOTE } } };
    const supplied = createUntrustedBoundary({ remotes: new Map([[REMOTE, { type: 'string' }]]), engine: ataEngine });
    expect(supplied.validate('refs', schema, { a: 'x' })).toEqual({ valid: true });
    expect(supplied.validate('refs', schema, { a: 1 }).valid).toBe(false);
    expect(() => createUntrustedBoundary({ remotes: new Map(), engine: ataEngine }).validate('refs', schema, { a: 'x' })).toThrow(SchemaValidatorFailure);
  });

  it('keeps the supplied documents out of the product boundary', () => {
    createUntrustedBoundary({ remotes: new Map([[REMOTE, { type: 'string' }]]), engine: ataEngine });
    expect(() => validateUntrusted('refs', { type: 'object', properties: { a: { $ref: REMOTE } } }, {})).toThrow(SchemaValidatorFailure);
  });

  it('reports the instance path, keyword and message of each failure', () => {
    const verdict = validateUntrusted('errors', { type: 'object', properties: { n: { type: 'integer', minimum: 3 } }, required: ['m'] }, { n: 1 });
    expect(verdict.valid).toBe(false);
    if (verdict.valid) return;
    expect(verdict.errors.map(({ instancePath, keyword, message }) => ({ instancePath, keyword, message }))).toEqual(
      expect.arrayContaining([
        { instancePath: '', keyword: 'required', message: "must have required property 'm'" },
        { instancePath: '/n', keyword: 'minimum', message: 'must be >= 3' },
      ]),
    );
  });
});
