import { OPEN_RESPONSES_OPENAPI } from './open-responses-spec.ts';

export const OPEN_RESPONSES_REGISTRY_ID = 'https://momonga.invalid/open-responses/2026-04-24/openapi.json';

const COMPONENT_REFERENCE_PREFIX = '#/components/schemas/';
const REGISTRY_REFERENCE_PREFIX = '#/$defs/';
const OPENAPI_ONLY_KEYWORDS: ReadonlySet<string> = new Set(['discriminator', 'example']);
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const SCHEMA_LIST_KEYWORDS: ReadonlySet<string> = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set(['items', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'contains', 'not', 'if', 'then', 'else']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const standardSchema = (node: unknown): unknown => {
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (OPENAPI_ONLY_KEYWORDS.has(key) || key.startsWith('x-')) continue;
    if (key === '$ref' && typeof value === 'string' && value.startsWith(COMPONENT_REFERENCE_PREFIX)) {
      out[key] = REGISTRY_REFERENCE_PREFIX + value.slice(COMPONENT_REFERENCE_PREFIX.length);
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, standardSchema(child)]));
    } else if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) {
      out[key] = value.map(standardSchema);
    } else if (SCHEMA_KEYWORDS.has(key)) {
      out[key] = standardSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
};

export const openResponsesSchemaRegistry = (openapi: unknown): Record<string, unknown> => {
  if (!isRecord(openapi) || !isRecord(openapi['components']) || !isRecord(openapi['components']['schemas'])) {
    throw new TypeError('Open Responses spec: expected components.schemas');
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: OPEN_RESPONSES_REGISTRY_ID,
    $defs: Object.fromEntries(Object.entries(openapi['components']['schemas']).map(([name, schema]) => [name, standardSchema(schema)])),
  };
};

export const OPEN_RESPONSES_SCHEMA_REGISTRY: Readonly<Record<string, unknown>> = openResponsesSchemaRegistry(OPEN_RESPONSES_OPENAPI);

export const OPEN_RESPONSES_COMPONENT_NAMES: readonly string[] = Object.keys(OPEN_RESPONSES_SCHEMA_REGISTRY['$defs'] as Record<string, unknown>);

export const OPEN_RESPONSES_REMOTE_DOCUMENTS: ReadonlyMap<string, unknown> = new Map([[OPEN_RESPONSES_REGISTRY_ID, OPEN_RESPONSES_SCHEMA_REGISTRY]]);

export const openResponsesComponentSchema = (component: string): Record<string, unknown> => ({ $ref: `${OPEN_RESPONSES_REGISTRY_ID}#/$defs/${component}` });
