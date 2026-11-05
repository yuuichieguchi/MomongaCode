import { canonicalJson, sha256Hex } from './canonical-json.ts';
import { unresolvableReference } from './schema-references.ts';
import { META_SCHEMA_URIS, dialectOfSchema, dialectOfUri } from './untrusted-dialect.ts';
import type { SchemaDialect } from './untrusted-dialect.ts';
import { ataEngine } from './untrusted-engine.ts';
import type { Engine, EngineValidator } from './untrusted-engine.ts';
import { createErrorDescriber } from './untrusted-errors.ts';
import type { UntrustedError } from './untrusted-errors.ts';
import { capText, sanitizeServerText } from './untrusted-text.ts';

export type { UntrustedError } from './untrusted-errors.ts';

const MAX_CACHED_VALIDATORS = 512;
const MAX_FAILURE_MESSAGE_CHARS = 200;
const MAX_SCHEMA_PROBLEMS = 3;
const SYNTHETIC_ROOT_URI = 'urn:momonga:untrusted-root';

export const cleanFailureMessage = (message: string): string => capText(sanitizeServerText(message), MAX_FAILURE_MESSAGE_CHARS);

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
  const builtin = dialectOfUri(declared);
  if (builtin !== undefined) return { dialect: builtin, uri: META_SCHEMA_URIS[builtin], supplied: false };
  if (!remotes.has(declared)) throw new Error(`$schema "${declared}" is not draft 2020-12, draft-07 or a supplied document`);
  const dialect = dialectOfSchema(remotes.get(declared));
  if (dialect === undefined) throw new Error(`the supplied $schema document "${declared}" declares a $schema that is not draft 2020-12 or draft-07`);
  return { dialect, uri: declared, supplied: true };
};

const metaSchemaOf = (meta: Meta): Record<string, unknown> =>
  meta.supplied ? { $ref: meta.uri, $defs: { builtin: { $ref: META_SCHEMA_URIS['2020-12'] } } } : { $ref: meta.uri };

const registryOf = (remotes: RemoteDocuments): Record<string, object> =>
  Object.fromEntries(
    [...remotes].flatMap(([uri, document]) => {
      if (typeof document !== 'object' || document === null) return [];
      const record = document as Record<string, unknown>;
      return [[uri, '$id' in record || Array.isArray(record) ? record : { ...record, $id: uri }]];
    }),
  );

const absoluteIdOf = (schema: Record<string, unknown>): string | undefined => {
  const id = schema['$id'];
  return typeof id === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(id) ? id.split('#')[0] : undefined;
};

type Compilation = { readonly remotes: RemoteDocuments; readonly registry: Record<string, object>; readonly engine: Engine; readonly metas: Map<string, EngineValidator> };

const assertSchemaValid = (schema: Record<string, unknown>, meta: Meta, compilation: Compilation): void => {
  let validateMeta = compilation.metas.get(meta.uri);
  if (validateMeta === undefined) {
    validateMeta = compilation.engine.compile(metaSchemaOf(meta), compilation.registry);
    compilation.metas.set(meta.uri, validateMeta);
  }
  const verdict = validateMeta(schema);
  if (verdict.valid) return;
  const problems = verdict.errors.slice(0, MAX_SCHEMA_PROBLEMS).map((error) => `${error.instancePath || '(root)'} ${error.message}`);
  throw new Error(`schema is invalid: ${problems.join('; ')}`);
};

const compileIsolated = (schema: Record<string, unknown>, compilation: Compilation): UntrustedValidate => {
  const meta = metaOf(schema, compilation.remotes);
  assertSchemaValid(schema, meta, compilation);
  const unresolved = unresolvableReference(schema, meta.dialect, compilation.remotes);
  if (unresolved !== undefined) throw new Error(`$ref "${unresolved}" cannot be resolved`);
  const root = structuredClone(schema);
  const validate = compilation.engine.compile(root, compilation.registry);
  const rootUri = absoluteIdOf(root) ?? SYNTHETIC_ROOT_URI;
  const describe = createErrorDescriber({
    root: absoluteIdOf(root) === undefined ? { ...root, $id: rootUri } : root,
    rootUri,
    engine: compilation.engine,
    registry: compilation.registry,
  });
  return (data) => {
    const verdict = validate(data);
    return verdict.valid ? { valid: true } : { valid: false, errors: describe(verdict.errors, data) };
  };
};

const keyOf = (schema: Record<string, unknown>): string => sha256Hex(canonicalJson(schema));

const resolve = (entry: CacheEntry): UntrustedValidate => {
  if ('failure' in entry) throw new SchemaValidatorFailure(entry.failure);
  return entry.validate;
};

export const createUntrustedSchemaCompiler = ({ remotes, engine }: { remotes: RemoteDocuments; engine: Engine }): ((schema: Record<string, unknown>) => UntrustedValidate) & { cacheSize(): number; clear(): void } => {
  const documents: RemoteDocuments = new Map([...remotes].map(([uri, document]) => [uri, structuredClone(document)]));
  const compilation: Compilation = { remotes: documents, registry: registryOf(documents), engine, metas: new Map() };
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
      entry = { validate: compileIsolated(schema, compilation) };
    } catch (error) {
      entry = { failure: cleanFailureMessage(error instanceof Error ? error.message : String(error)) };
    }
    remember(key, entry);
    return resolve(entry);
  };
  return Object.assign(compile, { cacheSize: () => cache.size, clear: () => cache.clear() });
};

export const compileUntrustedSchema = createUntrustedSchemaCompiler({ remotes: NO_REMOTE_DOCUMENTS, engine: ataEngine });

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
