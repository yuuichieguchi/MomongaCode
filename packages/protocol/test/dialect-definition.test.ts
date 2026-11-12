import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { BUILTIN_DIALECTS, BUILTIN_DIALECT_IDS, DEFAULT_DIALECT_ID, DIALECT_DEFINITION_SCHEMA } from '@momonga/protocol';
import type {
  Capabilities,
  ConstructResult,
  ConstructSupport,
  DialectDefinition,
  DialectId,
  MomongaResponseExtension,
  SchemaNarrowing,
  Segment,
  WrapRecord,
} from '@momonga/protocol';

const WITHIN_UNION = { below: ['anyOf'], through: ['properties', 'items', 'anyOf'] };

const EXPECTED_BUILTINS = {
  'json-schema-2020-12': { rules: [] },
  'explicit-keys': {
    rules: [
      { select: [{ kinds: ['root'] }, { kinds: ['tool-parameters'] }], op: 'inline-refs' },
      { select: [{ kinds: ['any'] }], op: 'split-type-array' },
      { select: [{ kinds: ['enum'] }], op: 'split-enum' },
      { select: [{ kinds: ['tool-parameters', 'untyped'] }, { kinds: ['root', 'untyped'] }], op: 'fill-type', fallback: 'object' },
      { select: [{ kinds: ['untyped'] }], op: 'fill-type', fallback: 'string' },
      { select: [{ kinds: ['tool-parameters'] }], op: 'empty-parameters' },
      { select: [{ kinds: ['object-without-properties'] }], op: 'ensure-key', key: 'properties', value: {} },
      { select: [{ kinds: ['any-of'] }], op: 'label', key: 'title' },
      { select: [{ kinds: ['object-with-properties'], within: WITHIN_UNION }], op: 'label', key: 'title' },
      { select: [{ kinds: ['object-with-properties'] }], op: 'property-order', key: 'x-order' },
      { select: [{ kinds: ['object-with-properties'], within: WITHIN_UNION }], op: 'ensure-key', key: 'additionalProperties', value: true },
      { select: [{ kinds: ['object-with-properties'], within: WITHIN_UNION }], op: 'ensure-key', key: 'required', value: [] },
      { select: [{ kinds: ['object-with-properties'] }], op: 'ensure-key', key: 'additionalProperties', value: false, overwrite: 'non-boolean' },
    ],
  },
  'strict-closed': {
    rules: [
      {
        select: [{ kinds: ['any'] }],
        op: 'reject',
        keys: ['$ref', '$defs', 'definitions', 'allOf', 'oneOf', 'patternProperties', 'dependentSchemas', 'dependencies',
          'unevaluatedProperties', 'propertyNames', 'contains', 'prefixItems', 'not', 'if', 'then', 'else'],
      },
      { select: [{ kinds: ['tool-parameters'] }], op: 'nullable-optional' },
      { select: [{ kinds: ['object-with-properties'] }, { kinds: ['object-without-properties'] }], op: 'ensure-key', key: 'additionalProperties', value: false, overwrite: 'always' },
      { select: [{ kinds: ['object-with-properties'] }], op: 'require-all' },
    ],
  },
  'inlined-subset': {
    rules: [
      { select: [{ kinds: ['root'] }, { kinds: ['tool-parameters'] }], op: 'inline-refs' },
      { select: [{ kinds: ['root'] }, { kinds: ['tool-parameters'] }], op: 'drop', keys: ['$schema'] },
      { select: [{ kinds: ['tool-parameters'] }], op: 'empty-parameters' },
      { select: [{ kinds: ['tool-parameters'] }, { kinds: ['object-without-properties'] }], op: 'ensure-key', key: 'properties', value: {} },
      { select: [{ kinds: ['object-with-properties'] }, { kinds: ['object-without-properties'] }], op: 'declare-required' },
    ],
  },
};

let compiled: ((data: unknown) => boolean) | undefined;
const validate = (definition: unknown): boolean => {
  compiled ??= new Ajv2020.default({ strict: false }).compile(DIALECT_DEFINITION_SCHEMA as object);
  return compiled(definition);
};

const ruleDefinition = (rule: unknown) => ({ rules: [rule] });

describe('dialect types', () => {
  it('makes a dialect id an open string and the resolved capability one id', () => {
    expectTypeOf<DialectId>().toEqualTypeOf<string>();
    expectTypeOf<Capabilities['schemaDialect']>().toEqualTypeOf<DialectId>();
  });

  it('defines the wrap record of nullable-optional with its path segments', () => {
    expectTypeOf<Segment>().toEqualTypeOf<{ property: string } | { items: true }>();
    expectTypeOf<WrapRecord>().toEqualTypeOf<{ tool: string; wrapped: { at: Segment[]; property: string }[] }>();
  });

  it('defines a narrowing as the tool and the JSON Pointer of the narrowed parameter', () => {
    expectTypeOf<SchemaNarrowing>().toEqualTypeOf<{ tool: string; path: string }>();
    expectTypeOf<MomongaResponseExtension['schemaNarrowings']>().toEqualTypeOf<SchemaNarrowing[] | undefined>();
  });

  it('defines the construct table as one result per MCP-only construct', () => {
    expectTypeOf<ConstructResult>().toEqualTypeOf<'accepted' | 'refused' | 'unrenderable'>();
    expectTypeOf<ConstructSupport>().toEqualTypeOf<{ ref: ConstructResult; typeArray: ConstructResult; mixedEnum: ConstructResult }>();
  });

  it('types a built-in definition as a dialect definition', () => {
    expectTypeOf<(typeof BUILTIN_DIALECTS)[keyof typeof BUILTIN_DIALECTS]>().toExtend<DialectDefinition>();
  });
});

describe('the four built-in dialects', () => {
  it('lists exactly the four built-in ids', () => {
    expect([...BUILTIN_DIALECT_IDS].sort()).toEqual(['explicit-keys', 'inlined-subset', 'json-schema-2020-12', 'strict-closed']);
    expect(Object.keys(BUILTIN_DIALECTS).sort()).toEqual([...BUILTIN_DIALECT_IDS].sort());
  });

  it('defaults to the identity dialect', () => {
    expect(DEFAULT_DIALECT_ID).toBe('json-schema-2020-12');
  });

  it.each(Object.entries(EXPECTED_BUILTINS))('ships %s as the data of the design', (id, definition) => {
    expect(BUILTIN_DIALECTS[id as keyof typeof BUILTIN_DIALECTS]).toEqual({ ...definition, strictPerTool: id === 'strict-closed' });
  });

  it.each(Object.keys(EXPECTED_BUILTINS))('validates %s against the definition schema', (id) => {
    expect(validate(BUILTIN_DIALECTS[id as keyof typeof BUILTIN_DIALECTS])).toBe(true);
  });
});

describe('the dialect definition schema', () => {
  it('accepts the user dialect of the design that extends a built-in', () => {
    expect(validate({ extends: 'inlined-subset', rules: [{ select: [{ kinds: ['object-with-properties'] }], op: 'property-order', key: 'propertyOrdering' }] })).toBe(true);
  });

  it.each([
    ['additionalProperties true with overwrite', { select: [{ kinds: ['any'] }], op: 'ensure-key', key: 'additionalProperties', value: true, overwrite: 'always' }],
    ['required with a name', { select: [{ kinds: ['any'] }], op: 'ensure-key', key: 'required', value: ['a'] }],
    ['an assertion keyword', { select: [{ kinds: ['any'] }], op: 'ensure-key', key: 'minimum', value: 0 }],
    ['properties with an entry', { select: [{ kinds: ['any'] }], op: 'ensure-key', key: 'properties', value: { a: {} } }],
  ])('rejects ensure-key with %s', (_name, rule) => {
    expect(validate(ruleDefinition(rule))).toBe(false);
  });

  it('accepts ensure-key of an annotation key and of additionalProperties false with overwrite', () => {
    expect(validate(ruleDefinition({ select: [{ kinds: ['any'] }], op: 'ensure-key', key: 'x-note', value: 1 }))).toBe(true);
    expect(validate(ruleDefinition({ select: [{ kinds: ['any'] }], op: 'ensure-key', key: 'additionalProperties', value: false, overwrite: 'always' }))).toBe(true);
  });

  it.each([
    ['a root clause', [{ kinds: ['root'] }]],
    ['a within', [{ kinds: ['tool-parameters'], within: { below: ['properties'], through: ['properties'] } }]],
    ['another kind in the clause', [{ kinds: ['tool-parameters', 'untyped'] }]],
    ['a second clause of another kind', [{ kinds: ['tool-parameters'] }, { kinds: ['any'] }]],
  ])('rejects nullable-optional on %s', (_name, select) => {
    expect(validate(ruleDefinition({ select, op: 'nullable-optional' }))).toBe(false);
  });

  it.each(['oneOf', 'not', 'if'])('rejects a rule of class N or W that descends through %s', (keyword) => {
    const within = { below: ['anyOf'], through: ['properties', keyword] };
    expect(validate(ruleDefinition({ select: [{ kinds: ['any'], within }], op: 'drop', keys: ['pattern'] }))).toBe(false);
    expect(validate(ruleDefinition({ select: [{ kinds: ['any'], within }], op: 'require-all' }))).toBe(false);
    expect(validate(ruleDefinition({ select: [{ kinds: ['untyped'], within }], op: 'fill-type', fallback: 'string' }))).toBe(false);
    expect(validate(ruleDefinition({ select: [{ kinds: ['any'], within }], op: 'ensure-key', key: 'additionalProperties', value: false }))).toBe(false);
  });

  it('lets a class P rule descend through oneOf, not and if', () => {
    const within = { below: ['oneOf'], through: ['not', 'if'] };
    expect(validate(ruleDefinition({ select: [{ kinds: ['any-of'], within }], op: 'label', key: 'title' }))).toBe(true);
  });

  it.each([
    ['an id with an upper-case letter', { extends: 'Explicit', rules: [] }],
    ['an unknown op', { rules: [{ select: [{ kinds: ['any'] }], op: 'rename' }] }],
    ['an unknown kind', { rules: [{ select: [{ kinds: ['object'] }], op: 'require-all' }] }],
    ['a label key that is a vocabulary keyword', { rules: [{ select: [{ kinds: ['any'] }], op: 'label', key: 'description' }] }],
    ['an unknown top-level key', { rules: [], name: 'x' }],
    ['no rules', {}],
  ])('rejects %s', (_name, definition) => {
    expect(validate(definition)).toBe(false);
  });
});
