export type DialectId = string;

export const DIALECT_ID_PATTERN = '^[a-z][a-z0-9-]{0,62}$';

export const DIALECT_KINDS = [
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

export type DialectKind = (typeof DIALECT_KINDS)[number];

export const DIALECT_POSITIVE_DESCENTS = [
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

export const DIALECT_NON_POSITIVE_DESCENTS = ['oneOf', 'not', 'if'] as const;

export type DialectPositiveDescent = (typeof DIALECT_POSITIVE_DESCENTS)[number];
export type DialectDescent = DialectPositiveDescent | (typeof DIALECT_NON_POSITIVE_DESCENTS)[number];

export const DIALECT_FILL_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array'] as const;

export type DialectFillType = (typeof DIALECT_FILL_TYPES)[number];

export const DIALECT_VOCABULARY_KEYWORDS = [
  '$schema',
  '$id',
  '$ref',
  '$defs',
  '$anchor',
  '$dynamicRef',
  '$dynamicAnchor',
  '$vocabulary',
  '$comment',
  '$recursiveRef',
  '$recursiveAnchor',
  'definitions',
  'dependencies',
  'additionalItems',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'prefixItems',
  'items',
  'contains',
  'properties',
  'patternProperties',
  'additionalProperties',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
  'type',
  'enum',
  'const',
  'multipleOf',
  'maximum',
  'exclusiveMaximum',
  'minimum',
  'exclusiveMinimum',
  'maxLength',
  'minLength',
  'pattern',
  'maxItems',
  'minItems',
  'uniqueItems',
  'maxContains',
  'minContains',
  'maxProperties',
  'minProperties',
  'required',
  'dependentRequired',
  'format',
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
  'title',
  'description',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
  'examples',
] as const;

export type DialectClause = {
  kinds: DialectKind[];
  within?: { below: DialectDescent[]; through: DialectDescent[] };
};

export type DialectSelect = DialectClause[];

export type DialectOverwrite = 'never' | 'non-boolean' | 'always';

export type DialectRule =
  | { select: DialectSelect; op: 'reject' | 'drop'; keys: string[] }
  | { select: DialectSelect; op: 'fill-type'; fallback: DialectFillType }
  | {
      select: DialectSelect;
      op: 'split-enum' | 'split-type-array' | 'const-as-enum' | 'declare-required' | 'inline-refs' | 'require-all' | 'empty-parameters' | 'nullable-optional';
    }
  | { select: DialectSelect; op: 'label' | 'property-order'; key: string }
  | { select: DialectSelect; op: 'ensure-key'; key: string; value: unknown; overwrite?: DialectOverwrite };

export type DialectOp = DialectRule['op'];

export type DialectDefinition = { extends?: DialectId; rules: DialectRule[]; strictPerTool?: boolean };

export type BuiltinDialectDefinition = DialectDefinition & { strictPerTool: boolean };

export const strictPerToolOf = (definition: DialectDefinition): boolean => definition.strictPerTool === true;

export type Segment = { property: string } | { items: true };

export type WrapRecord = { tool: string; wrapped: { at: Segment[]; property: string }[] };

export type SchemaNarrowing = { tool: string; path: string };

export type ConstructResult = 'accepted' | 'refused' | 'unrenderable';

export type ConstructSupport = { ref: ConstructResult; typeArray: ConstructResult; mixedEnum: ConstructResult };

const ID = '#/$defs/id';
const CLAUSE = '#/$defs/clause';

export const DIALECT_DEFINITION_SCHEMA: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'momonga:dialect-definition',
  type: 'object',
  properties: {
    extends: { $ref: ID },
    rules: { type: 'array', items: { $ref: '#/$defs/rule' } },
    strictPerTool: { type: 'boolean' },
  },
  required: ['rules'],
  additionalProperties: false,
  $defs: {
    id: { type: 'string', pattern: DIALECT_ID_PATTERN },
    kind: { enum: [...DIALECT_KINDS] },
    descentPositive: { enum: [...DIALECT_POSITIVE_DESCENTS] },
    descent: { anyOf: [{ $ref: '#/$defs/descentPositive' }, { enum: [...DIALECT_NON_POSITIVE_DESCENTS] }] },
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
      $ref: CLAUSE,
      type: 'object',
      properties: {
        within: {
          type: 'object',
          properties: {
            below: { type: 'array', items: { $ref: '#/$defs/descentPositive' } },
            through: { type: 'array', items: { $ref: '#/$defs/descentPositive' } },
          },
        },
      },
    },
    select: { type: 'array', items: { $ref: CLAUSE }, minItems: 1 },
    selectToolParameters: {
      type: 'array',
      items: { $ref: CLAUSE, type: 'object', properties: { kinds: { const: ['tool-parameters'] } }, not: { properties: { within: true }, required: ['within'] } },
      minItems: 1,
    },
    selectPositive: { type: 'array', items: { $ref: '#/$defs/clausePositive' }, minItems: 1 },
    keywordList: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, uniqueItems: true },
    annotationKey: { type: 'string', minLength: 1, not: { $ref: '#/$defs/vocabularyKeyword' } },
    labelKey: { anyOf: [{ const: 'title' }, { $ref: '#/$defs/annotationKey' }] },
    vocabularyKeyword: { enum: [...DIALECT_VOCABULARY_KEYWORDS] },
    rule: {
      type: 'object',
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
            fallback: { enum: [...DIALECT_FILL_TYPES] },
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
          properties: { select: { $ref: '#/$defs/selectToolParameters' }, op: { const: 'nullable-optional' } },
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
            { properties: { key: { $ref: '#/$defs/annotationKey' } }, not: { properties: { overwrite: true }, required: ['overwrite'] } },
            { properties: { key: { const: 'required' }, value: { const: [] } }, not: { properties: { overwrite: true }, required: ['overwrite'] } },
            { properties: { key: { const: 'properties' }, value: { const: {} } }, not: { properties: { overwrite: true }, required: ['overwrite'] } },
            { properties: { key: { const: 'additionalProperties' }, value: { const: true } }, not: { properties: { overwrite: true }, required: ['overwrite'] } },
            { properties: { key: { const: 'additionalProperties' }, value: { const: false } } },
          ],
        },
      ],
    },
  },
};
