import { Validator } from 'ata-validator/lite';
import { canonicalJson, sha256Hex } from './canonical-json.ts';
import { unresolvableReference } from './schema-references.ts';
import type { SchemaDialect } from './schema-references.ts';
import { describeUntrustedErrors } from './untrusted-errors.ts';
import type { RawError, UntrustedError } from './untrusted-errors.ts';
import { capText, sanitizeServerText } from './untrusted-text.ts';

export type { UntrustedError } from './untrusted-errors.ts';

const MAX_CACHED_VALIDATORS = 512;
const MAX_FAILURE_MESSAGE_CHARS = 200;
const MAX_SCHEMA_PROBLEMS = 3;

export const cleanFailureMessage = (message: string): string => capText(sanitizeServerText(message), MAX_FAILURE_MESSAGE_CHARS);

const DRAFT_07 = /^https?:\/\/json-schema\.org\/draft-07\/schema#?$/;
const DRAFT_2020_12 = /^https:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/;
const OPTIONS = { engine: 'interpreter', useDefaults: false, assertFormat: false, coerceTypes: false, removeAdditional: false } as const;
const META_SCHEMA_URIS = { 'draft-07': 'http://json-schema.org/draft-07/schema', '2020-12': 'https://json-schema.org/draft/2020-12/schema' } as const;

export type UntrustedVerdict = { valid: true } | { valid: false; errors: readonly UntrustedError[] };

export type UntrustedValidate = (data: unknown) => UntrustedVerdict;

export type RemoteDocuments = ReadonlyMap<string, unknown>;

export const NO_REMOTE_DOCUMENTS: RemoteDocuments = new Map();

type CacheEntry = { validate: UntrustedValidate } | { failure: string };

export class SchemaValidatorFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaValidatorFailure';
  }
}

type Meta = { readonly dialect: SchemaDialect; readonly uri: string; readonly supplied: boolean };

const metaOf = (schema: Record<string, unknown>, remotes: RemoteDocuments): Meta => {
  const declared = schema['$schema'];
  if (declared === undefined) return { dialect: '2020-12', uri: META_SCHEMA_URIS['2020-12'], supplied: false };
  if (typeof declared !== 'string') throw new Error('$schema must be a string');
  if (DRAFT_07.test(declared)) return { dialect: 'draft-07', uri: META_SCHEMA_URIS['draft-07'], supplied: false };
  if (DRAFT_2020_12.test(declared)) return { dialect: '2020-12', uri: META_SCHEMA_URIS['2020-12'], supplied: false };
  if (remotes.has(declared)) return { dialect: '2020-12', uri: declared, supplied: true };
  throw new Error(`$schema "${declared}" is not draft 2020-12, draft-07 or a supplied document`);
};

const builtinMetaValidators = new Map<SchemaDialect, Validator>();

const metaValidatorFor = (meta: Meta): Validator => {
  const existing = builtinMetaValidators.get(meta.dialect);
  if (existing !== undefined) return existing;
  const created = new Validator({ $ref: meta.uri }, OPTIONS);
  builtinMetaValidators.set(meta.dialect, created);
  return created;
};

const assertSchemaValid = (schema: Record<string, unknown>, meta: Meta): void => {
  if (meta.supplied) return;
  const verdict = metaValidatorFor(meta).validate(schema);
  if (verdict.valid) return;
  const problems = verdict.errors.slice(0, MAX_SCHEMA_PROBLEMS).map((error) => `${error.instancePath || '(root)'} ${error.message}`);
  throw new Error(`schema is invalid: ${problems.join('; ')}`);
};

const registryOf = (remotes: RemoteDocuments): Record<string, object> =>
  Object.fromEntries(
    [...remotes].flatMap(([uri, document]) => {
      if (typeof document !== 'object' || document === null) return [];
      const record = document as Record<string, unknown>;
      return [[uri, '$id' in record || Array.isArray(record) ? record : { ...record, $id: uri }]];
    }),
  );

const compileIsolated = (schema: Record<string, unknown>, remotes: RemoteDocuments, registry: Record<string, object>): UntrustedValidate => {
  const meta = metaOf(schema, remotes);
  assertSchemaValid(schema, meta);
  const unresolved = unresolvableReference(schema, meta.dialect, remotes);
  if (unresolved !== undefined) throw new Error(`$ref "${unresolved}" cannot be resolved`);
  const root = structuredClone(schema);
  const validator = new Validator(root, { ...OPTIONS, schemas: registry });
  validator.engine();
  const errorsOf = (candidate: Record<string, unknown>, instance: unknown): readonly RawError[] => new Validator(candidate, { ...OPTIONS, schemas: registry }).validate(instance).errors;
  return (data) => {
    const result = validator.validate(data);
    return result.valid ? { valid: true } : { valid: false, errors: describeUntrustedErrors(result.errors, { root, instance: data, errorsOf }) };
  };
};

const keyOf = (schema: Record<string, unknown>): string => sha256Hex(canonicalJson(schema));

const resolve = (entry: CacheEntry): UntrustedValidate => {
  if ('failure' in entry) throw new SchemaValidatorFailure(entry.failure);
  return entry.validate;
};

export const createUntrustedSchemaCompiler = (remotes: RemoteDocuments): ((schema: Record<string, unknown>) => UntrustedValidate) & { cacheSize(): number; clear(): void } => {
  const documents: RemoteDocuments = new Map([...remotes].map(([uri, document]) => [uri, structuredClone(document)]));
  const registry = registryOf(documents);
  const cache = new Map<string, CacheEntry>();
  const remember = (key: string, entry: CacheEntry): void => {
    cache.set(key, entry);
    if (cache.size > MAX_CACHED_VALIDATORS) {
      const oldest = cache.keys().next();
      if (oldest.done !== true) cache.delete(oldest.value);
    }
  };
  const compile = (schema: Record<string, unknown>): UntrustedValidate => {
    const key = keyOf(schema);
    const cached = cache.get(key);
    if (cached !== undefined) {
      cache.delete(key);
      cache.set(key, cached);
      return resolve(cached);
    }
    let entry: CacheEntry;
    try {
      entry = { validate: compileIsolated(schema, documents, registry) };
    } catch (error) {
      entry = { failure: cleanFailureMessage(error instanceof Error ? error.message : String(error)) };
    }
    remember(key, entry);
    return resolve(entry);
  };
  return Object.assign(compile, { cacheSize: () => cache.size, clear: () => cache.clear() });
};

export const compileUntrustedSchema = createUntrustedSchemaCompiler(NO_REMOTE_DOCUMENTS);

export const untrustedSchemaCacheSize = (): number => compileUntrustedSchema.cacheSize();

const MAX_RECORDED_FAILURES = 512;
const validateFailures = new Map<string, string>();

const failureKeyOf = (identity: string, schema: Record<string, unknown>): string => `${identity}\u0000${keyOf(schema)}`;

export const recordValidateFailure = (identity: string, schema: Record<string, unknown>, message: string): void => {
  const key = failureKeyOf(identity, schema);
  validateFailures.delete(key);
  validateFailures.set(key, cleanFailureMessage(message));
  if (validateFailures.size > MAX_RECORDED_FAILURES) {
    const oldest = validateFailures.keys().next();
    if (oldest.done !== true) validateFailures.delete(oldest.value);
  }
};

export const untrustedSchemaFailure = (identity: string, schema: Record<string, unknown>): string | undefined =>
  validateFailures.get(failureKeyOf(identity, schema));

export const clearUntrustedSchemaCaches = (): void => {
  compileUntrustedSchema.clear();
  validateFailures.clear();
};
