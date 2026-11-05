export type SchemaDialect = 'draft-07' | '2020-12';

const DRAFT_07_URIS: ReadonlySet<string> = new Set(['http://json-schema.org/draft-07/schema#', 'http://json-schema.org/draft-07/schema']);
const DRAFT_2020_12_URIS: ReadonlySet<string> = new Set(['https://json-schema.org/draft/2020-12/schema', 'https://json-schema.org/draft/2020-12/schema#']);

export const META_SCHEMA_URIS = { 'draft-07': 'http://json-schema.org/draft-07/schema', '2020-12': 'https://json-schema.org/draft/2020-12/schema' } as const;

export const dialectOfUri = (uri: string): SchemaDialect | undefined => {
  if (DRAFT_07_URIS.has(uri)) return 'draft-07';
  if (DRAFT_2020_12_URIS.has(uri)) return '2020-12';
  return undefined;
};

export const dialectOfSchema = (schema: unknown): SchemaDialect | undefined => {
  if (typeof schema !== 'object' || schema === null) return '2020-12';
  const declared = (schema as Record<string, unknown>)['$schema'];
  if (declared === undefined) return '2020-12';
  return typeof declared === 'string' ? dialectOfUri(declared) : undefined;
};
