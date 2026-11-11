import { UNKNOWN_VALUE } from './stored-value.ts';

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

export type JsonSchema = Readonly<Record<string, unknown>>;

export const closed = (properties: Record<string, JsonSchema>, required: readonly string[]): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const closedRequiringAll = (properties: Record<string, JsonSchema>): JsonSchema => closed(properties, Object.keys(properties));

export const root = (schema: JsonSchema): JsonSchema => ({ $schema: DRAFT_2020_12, ...schema });

export const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] });

export const string: JsonSchema = { type: 'string' };
export const nonEmptyString: JsonSchema = { type: 'string', minLength: 1 };
export const integer: JsonSchema = { type: 'integer' };
export const nonNegativeInteger: JsonSchema = { type: 'integer', minimum: 0 };
export const boolean: JsonSchema = { type: 'boolean' };
export const anything: JsonSchema = {};
export const enumOf = (values: readonly string[]): JsonSchema => ({ type: 'string', enum: values });
export const storedEnumOf = (values: readonly string[]): JsonSchema => enumOf([...values, UNKNOWN_VALUE]);
export const constant = (value: string): JsonSchema => ({ type: 'string', const: value });
export const boundedInteger = (minimum: number, maximum: number): JsonSchema => ({ type: 'integer', minimum, maximum });
