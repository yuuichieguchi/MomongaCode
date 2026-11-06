import type { Json } from './json.ts';

export const KINDS = [
  'any',
  'root',
  'tool-parameters',
  'object-with-properties',
  'object-without-properties',
  'any-of',
  'any-of-branch',
  'enum',
  'const',
  'untyped',
  'array',
  'type-string',
  'type-number',
  'type-integer',
  'type-boolean',
  'type-null',
] as const;
export type Kind = (typeof KINDS)[number];

export const DESCENT_POSITIVE = [
  'properties',
  'items',
  'prefixItems',
  'additionalProperties',
  'patternProperties',
  'anyOf',
  'allOf',
  'then',
  'else',
  'dependentSchemas',
  'contains',
  '$defs',
  'definitions',
] as const;
export const DESCENT = [...DESCENT_POSITIVE, 'oneOf', 'not', 'if'] as const;

export interface Clause {
  kinds: Kind[];
  within?: { below: string[]; through: string[] };
}

export type Rule =
  | { select: Clause[]; op: 'reject'; keys: string[] }
  | { select: Clause[]; op: 'drop'; keys: string[] }
  | { select: Clause[]; op: 'fill-type'; fallback: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' }
  | { select: Clause[]; op: 'split-enum' | 'split-type-array' | 'const-as-enum' | 'declare-required' | 'inline-refs' }
  | { select: Clause[]; op: 'require-all' | 'empty-parameters' }
  | { select: Clause[]; op: 'label'; key: string }
  | { select: Clause[]; op: 'property-order'; key: string }
  | { select: Clause[]; op: 'ensure-key'; key: string; value: Json; overwrite?: 'never' | 'non-boolean' | 'always' };

export type Op = Rule['op'];

export interface Definition {
  extends?: string;
  rules: Rule[];
}

export const OPS: readonly Op[] = [
  'drop',
  'reject',
  'fill-type',
  'split-enum',
  'split-type-array',
  'const-as-enum',
  'ensure-key',
  'label',
  'property-order',
  'require-all',
  'declare-required',
  'inline-refs',
  'empty-parameters',
];

export type SoundnessClass = 'P' | 'N' | 'W' | 'none';

export const classOf = (rule: Rule): SoundnessClass => {
  switch (rule.op) {
    case 'drop':
      return 'W';
    case 'reject':
      return 'none';
    case 'fill-type':
    case 'require-all':
    case 'empty-parameters':
      return 'N';
    case 'ensure-key':
      return rule.key === 'additionalProperties' && rule.value === false ? 'N' : 'P';
    default:
      return 'P';
  }
};

export const VOCABULARY_KEYWORDS = [
  '$schema', '$id', '$ref', '$defs', '$anchor', '$dynamicRef', '$dynamicAnchor', '$vocabulary', '$comment',
  '$recursiveRef', '$recursiveAnchor', 'definitions', 'dependencies', 'additionalItems',
  'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'dependentSchemas', 'prefixItems', 'items', 'contains',
  'properties', 'patternProperties', 'additionalProperties', 'propertyNames', 'unevaluatedItems', 'unevaluatedProperties',
  'type', 'enum', 'const', 'multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum', 'maxLength',
  'minLength', 'pattern', 'maxItems', 'minItems', 'uniqueItems', 'maxContains', 'minContains', 'maxProperties',
  'minProperties', 'required', 'dependentRequired', 'format', 'contentEncoding', 'contentMediaType', 'contentSchema',
  'title', 'description', 'default', 'deprecated', 'readOnly', 'writeOnly', 'examples',
] as const;

export const DEFINITION_SCHEMA: Json = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'momonga:dialect-definition',
  type: 'object',
  properties: {
    extends: { $ref: '#/$defs/id' },
    rules: { type: 'array', items: { $ref: '#/$defs/rule' } },
  },
  required: ['rules'],
  additionalProperties: false,
  $defs: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,62}$' },
    kind: { enum: [...KINDS] },
    descentPositive: { enum: [...DESCENT_POSITIVE] },
    descent: { anyOf: [{ $ref: '#/$defs/descentPositive' }, { enum: ['oneOf', 'not', 'if'] }] },
    clause: {
      type: 'object',
      properties: {
        kinds: { type: 'array', items: { $ref: '#/$defs/kind' }, minItems: 1, uniqueItems: true },
        within: {
          type: 'object',
          properties: {
            below: { type: 'array', items: { $ref: '#/$defs/descent' }, minItems: 1, uniqueItems: true },
            through: { type: 'array', items: { $ref: '#/$defs/descent' }, minItems: 1, uniqueItems: true },
          },
          required: ['below', 'through'],
          additionalProperties: false,
        },
      },
      required: ['kinds'],
      additionalProperties: false,
    },
    clausePositive: {
      $ref: '#/$defs/clause',
      properties: {
        within: {
          properties: {
            below: { items: { $ref: '#/$defs/descentPositive' } },
            through: { items: { $ref: '#/$defs/descentPositive' } },
          },
        },
      },
    },
    select: { type: 'array', items: { $ref: '#/$defs/clause' }, minItems: 1 },
    selectPositive: { type: 'array', items: { $ref: '#/$defs/clausePositive' }, minItems: 1 },
    keywordList: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, uniqueItems: true },
    annotationKey: { type: 'string', minLength: 1, not: { $ref: '#/$defs/vocabularyKeyword' } },
    labelKey: { anyOf: [{ const: 'title' }, { $ref: '#/$defs/annotationKey' }] },
    vocabularyKeyword: { enum: [...VOCABULARY_KEYWORDS] },
    rule: {
      oneOf: [
        {
          properties: { select: { $ref: '#/$defs/select' }, op: { const: 'reject' }, keys: { $ref: '#/$defs/keywordList' } },
          required: ['select', 'op', 'keys'],
          additionalProperties: false,
        },
        {
          properties: { select: { $ref: '#/$defs/selectPositive' }, op: { const: 'drop' }, keys: { $ref: '#/$defs/keywordList' } },
          required: ['select', 'op', 'keys'],
          additionalProperties: false,
        },
        {
          properties: {
            select: { $ref: '#/$defs/selectPositive' },
            op: { const: 'fill-type' },
            fallback: { enum: ['string', 'number', 'integer', 'boolean', 'object', 'array'] },
          },
          required: ['select', 'op', 'fallback'],
          additionalProperties: false,
        },
        {
          properties: {
            select: { $ref: '#/$defs/select' },
            op: { enum: ['split-enum', 'split-type-array', 'const-as-enum', 'declare-required', 'inline-refs'] },
          },
          required: ['select', 'op'],
          additionalProperties: false,
        },
        {
          properties: { select: { $ref: '#/$defs/selectPositive' }, op: { enum: ['require-all', 'empty-parameters'] } },
          required: ['select', 'op'],
          additionalProperties: false,
        },
        {
          properties: { select: { $ref: '#/$defs/select' }, op: { const: 'label' }, key: { $ref: '#/$defs/labelKey' } },
          required: ['select', 'op', 'key'],
          additionalProperties: false,
        },
        {
          properties: { select: { $ref: '#/$defs/select' }, op: { const: 'property-order' }, key: { $ref: '#/$defs/annotationKey' } },
          required: ['select', 'op', 'key'],
          additionalProperties: false,
        },
        {
          properties: {
            select: { $ref: '#/$defs/selectPositive' },
            op: { const: 'ensure-key' },
            key: true,
            value: true,
            overwrite: { enum: ['never', 'non-boolean', 'always'] },
          },
          required: ['select', 'op', 'key', 'value'],
          additionalProperties: false,
          oneOf: [
            { properties: { key: { $ref: '#/$defs/annotationKey' } }, not: { required: ['overwrite'] } },
            { properties: { key: { const: 'required' }, value: { const: [] } }, not: { required: ['overwrite'] } },
            { properties: { key: { const: 'properties' }, value: { const: {} } }, not: { required: ['overwrite'] } },
            { properties: { key: { const: 'additionalProperties' }, value: { const: true } }, not: { required: ['overwrite'] } },
            { properties: { key: { const: 'additionalProperties' }, value: { const: false } } },
          ],
        },
      ],
    },
  },
};

const ANY: Clause[] = [{ kinds: ['any'] }];
const ROOT_OR_PARAMETERS: Clause[] = [{ kinds: ['root'] }, { kinds: ['tool-parameters'] }];
const UNION_REGION = { below: ['anyOf'], through: ['properties', 'items', 'anyOf'] };

export const BUILTINS: Record<string, Definition> = {
  'json-schema-2020-12': { rules: [] },
  'explicit-keys': {
    rules: [
      { select: ROOT_OR_PARAMETERS, op: 'inline-refs' },
      { select: ANY, op: 'split-type-array' },
      { select: [{ kinds: ['enum'] }], op: 'split-enum' },
      { select: [{ kinds: ['tool-parameters', 'untyped'] }, { kinds: ['root', 'untyped'] }], op: 'fill-type', fallback: 'object' },
      { select: [{ kinds: ['untyped'] }], op: 'fill-type', fallback: 'string' },
      { select: [{ kinds: ['tool-parameters'] }], op: 'empty-parameters' },
      { select: [{ kinds: ['object-without-properties'] }], op: 'ensure-key', key: 'properties', value: {} },
      { select: [{ kinds: ['any-of'] }], op: 'label', key: 'title' },
      { select: [{ kinds: ['object-with-properties'], within: UNION_REGION }], op: 'label', key: 'title' },
      { select: [{ kinds: ['object-with-properties'] }], op: 'property-order', key: 'x-order' },
      { select: [{ kinds: ['object-with-properties'], within: UNION_REGION }], op: 'ensure-key', key: 'additionalProperties', value: true },
      { select: [{ kinds: ['object-with-properties'], within: UNION_REGION }], op: 'ensure-key', key: 'required', value: [] },
      { select: [{ kinds: ['object-with-properties'] }], op: 'ensure-key', key: 'additionalProperties', value: false, overwrite: 'non-boolean' },
    ],
  },
  'strict-closed': {
    rules: [
      {
        select: ANY,
        op: 'reject',
        keys: [
          '$ref', '$defs', 'definitions', 'allOf', 'oneOf', 'patternProperties', 'dependentSchemas', 'dependencies',
          'unevaluatedProperties', 'propertyNames', 'contains', 'prefixItems', 'not', 'if', 'then', 'else',
        ],
      },
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
    rules: [
      { select: ROOT_OR_PARAMETERS, op: 'inline-refs' },
      { select: ROOT_OR_PARAMETERS, op: 'drop', keys: ['$schema'] },
      { select: [{ kinds: ['tool-parameters'] }], op: 'empty-parameters' },
      { select: [{ kinds: ['tool-parameters'] }, { kinds: ['object-without-properties'] }], op: 'ensure-key', key: 'properties', value: {} },
      { select: [{ kinds: ['object-with-properties'] }, { kinds: ['object-without-properties'] }], op: 'declare-required' },
    ],
  },
};

export const resolveRules = (definition: Definition): Rule[] => {
  if (definition.extends === undefined) return definition.rules;
  const base = BUILTINS[definition.extends];
  if (base === undefined) throw new Error(`unknown built-in ${definition.extends}`);
  return [...base.rules, ...definition.rules];
};
