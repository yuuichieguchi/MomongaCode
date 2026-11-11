import { canonicalJson } from '@momonga/foundation';

export const MAX_SCHEMA_BYTES = 64 * 1024;

type SchemaObject = Record<string, unknown>;

export class SchemaRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaRejectedError';
  }
}

export const boundedSchemaCopy = (schema: SchemaObject): SchemaObject => {
  const bytes = Buffer.byteLength(canonicalJson(schema));
  if (bytes > MAX_SCHEMA_BYTES) {
    throw new SchemaRejectedError(`input schema is ${Math.ceil(bytes / 1024)} KiB, over the ${MAX_SCHEMA_BYTES / 1024} KiB limit`);
  }
  return structuredClone(schema);
};
