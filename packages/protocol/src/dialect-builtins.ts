import type { BuiltinDialectDefinition, DialectSelect } from './dialect.ts';

export const BUILTIN_DIALECT_IDS = ['json-schema-2020-12', 'inlined-subset', 'strict-closed', 'explicit-keys'] as const;

export type BuiltinDialectId = (typeof BUILTIN_DIALECT_IDS)[number];

export const DEFAULT_DIALECT_ID: BuiltinDialectId = 'json-schema-2020-12';

const WITHIN_UNION = { below: ['anyOf'], through: ['properties', 'items', 'anyOf'] } as const;

const withinUnion = (kind: 'object-with-properties'): DialectSelect => [
  { kinds: [kind], within: { below: [...WITHIN_UNION.below], through: [...WITHIN_UNION.through] } },
];

export const BUILTIN_DIALECTS: Record<BuiltinDialectId, BuiltinDialectDefinition> = {
  'json-schema-2020-12': { rules: [], strictPerTool: false },
  'explicit-keys': {
    strictPerTool: false,
    rules: [
      { select: [{ kinds: ['root'] }, { kinds: ['tool-parameters'] }], op: 'inline-refs' },
      { select: [{ kinds: ['any'] }], op: 'split-type-array' },
      { select: [{ kinds: ['enum'] }], op: 'split-enum' },
      { select: [{ kinds: ['tool-parameters', 'untyped'] }, { kinds: ['root', 'untyped'] }], op: 'fill-type', fallback: 'object' },
      { select: [{ kinds: ['untyped'] }], op: 'fill-type', fallback: 'string' },
      { select: [{ kinds: ['tool-parameters'] }], op: 'empty-parameters' },
      { select: [{ kinds: ['object-without-properties'] }], op: 'ensure-key', key: 'properties', value: {} },
      { select: [{ kinds: ['any-of'] }], op: 'label', key: 'title' },
      { select: withinUnion('object-with-properties'), op: 'label', key: 'title' },
      { select: [{ kinds: ['object-with-properties'] }], op: 'property-order', key: 'x-order' },
      { select: withinUnion('object-with-properties'), op: 'ensure-key', key: 'additionalProperties', value: true },
      { select: withinUnion('object-with-properties'), op: 'ensure-key', key: 'required', value: [] },
      { select: [{ kinds: ['object-with-properties'] }], op: 'ensure-key', key: 'additionalProperties', value: false, overwrite: 'non-boolean' },
    ],
  },
  'strict-closed': {
    strictPerTool: true,
    rules: [
      {
        select: [{ kinds: ['any'] }],
        op: 'reject',
        keys: [
          '$ref',
          '$defs',
          'definitions',
          'allOf',
          'oneOf',
          'patternProperties',
          'dependentSchemas',
          'dependencies',
          'unevaluatedProperties',
          'propertyNames',
          'contains',
          'prefixItems',
          'not',
          'if',
          'then',
          'else',
        ],
      },
      { select: [{ kinds: ['tool-parameters'] }], op: 'nullable-optional' },
      {
        select: [{ kinds: ['object-with-properties'] }, { kinds: ['object-without-properties'] }],
        op: 'ensure-key',
        key: 'additionalProperties',
        value: false,
        overwrite: 'always',
      },
      { select: [{ kinds: ['object-with-properties'] }], op: 'require-all' },
    ],
  },
  'inlined-subset': {
    strictPerTool: false,
    rules: [
      { select: [{ kinds: ['root'] }, { kinds: ['tool-parameters'] }], op: 'inline-refs' },
      { select: [{ kinds: ['root'] }, { kinds: ['tool-parameters'] }], op: 'drop', keys: ['$schema'] },
      { select: [{ kinds: ['tool-parameters'] }], op: 'empty-parameters' },
      { select: [{ kinds: ['tool-parameters'] }, { kinds: ['object-without-properties'] }], op: 'ensure-key', key: 'properties', value: {} },
      { select: [{ kinds: ['object-with-properties'] }, { kinds: ['object-without-properties'] }], op: 'declare-required' },
    ],
  },
};
