import { canonicalJson } from '@momonga/foundation';

export const MAX_SCHEMA_BYTES = 64 * 1024;

type SchemaObject = Record<string, unknown>;

const SCHEMA_KEYWORDS = new Set([
  'items',
  'additionalItems',
  'additionalProperties',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'propertyNames',
  'contentSchema',
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items']);
const SCHEMA_MAP_KEYWORDS = new Set(['properties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);

const isObject = (value: unknown): value is SchemaObject => typeof value === 'object' && value !== null && !Array.isArray(value);

export class SchemaRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaRejectedError';
  }
}

const sanitizeSubschema = (value: unknown): unknown => (isObject(value) ? sanitizeObject(value) : value);

const sanitizeMap = (value: unknown): unknown => {
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, Array.isArray(entry) ? entry : sanitizeSubschema(entry)]));
};

const sanitizeObject = (schema: SchemaObject): SchemaObject => {
  const hadPatternProperties = 'patternProperties' in schema;
  const result: SchemaObject = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (keyword === 'pattern' || keyword === 'patternProperties') continue;
    if (SCHEMA_MAP_KEYWORDS.has(keyword)) result[keyword] = sanitizeMap(value);
    else if (SCHEMA_ARRAY_KEYWORDS.has(keyword) && Array.isArray(value)) result[keyword] = value.map(sanitizeSubschema);
    else if (SCHEMA_KEYWORDS.has(keyword)) result[keyword] = sanitizeSubschema(value);
    else result[keyword] = value;
  }
  if (hadPatternProperties && result['additionalProperties'] === false) result['additionalProperties'] = true;
  return result;
};

export const sanitizeSchema = (schema: SchemaObject): SchemaObject => {
  const bytes = Buffer.byteLength(canonicalJson(schema));
  if (bytes > MAX_SCHEMA_BYTES) {
    throw new SchemaRejectedError(`input schema is ${Math.ceil(bytes / 1024)} KiB, over the ${MAX_SCHEMA_BYTES / 1024} KiB limit`);
  }
  return sanitizeObject(schema);
};
