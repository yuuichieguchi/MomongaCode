import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import type AjvCoreModule from 'ajv/dist/core.js';
import type { Options, ValidateFunction } from 'ajv/dist/core.js';
import addFormats from 'ajv-formats';
import { canonicalJson, sha256Hex } from './canonical-json.ts';
import { capText, sanitizeServerText } from './untrusted-text.ts';

const MAX_CACHED_VALIDATORS = 512;
const MAX_FAILURE_MESSAGE_CHARS = 200;

export const cleanFailureMessage = (message: string): string => capText(sanitizeServerText(message), MAX_FAILURE_MESSAGE_CHARS);
const DRAFT_07 = /^https?:\/\/json-schema\.org\/draft-07\/schema#?$/;
const OPTIONS = { strict: false, logger: false, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false } as const;
const ISOLATED_COMPILER_OPTIONS = { ...OPTIONS, validateSchema: false } as const;

type AjvCore = AjvCoreModule.default;

type CacheEntry = { validate: ValidateFunction } | { failure: string };

export class SchemaValidatorFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaValidatorFailure';
  }
}

type Dialect = {
  readonly checker: AjvCore;
  readonly defaultMetaKey: string;
  readonly metaValidators: ReadonlyMap<string, ValidateFunction>;
  readonly createIsolatedCompiler: () => AjvCore;
};

const cache = new Map<string, CacheEntry>();

const remoteSchemas = new Map<string, unknown>();

export const registerUntrustedRemoteSchemas = (remotes: Readonly<Record<string, unknown>>): void => {
  for (const [uri, schema] of Object.entries(remotes)) remoteSchemas.set(uri, schema);
  cache.clear();
};

const withRemotes = (instance: AjvCore): AjvCore => {
  for (const [uri, schema] of remoteSchemas) instance.addSchema(structuredClone(schema) as Record<string, unknown>, uri);
  return instance;
};

const withFormats = (instance: AjvCore): AjvCore => {
  addFormats.default(instance);
  return instance;
};

const collectMetaValidators = (checker: AjvCore): Map<string, ValidateFunction> => {
  const validators = new Map<string, ValidateFunction>();
  for (const key of [...Object.keys(checker.schemas), ...Object.keys(checker.refs)]) {
    const validate = checker.getSchema(key);
    if (validate !== undefined) validators.set(key, validate);
  }
  return validators;
};

const buildDialect = (construct: (options: Options) => AjvCore): Dialect => {
  const checker = withFormats(construct(OPTIONS));
  const defaultMetaKey = checker.defaultMeta();
  if (typeof defaultMetaKey !== 'string') throw new Error('ajv dialect has no default meta-schema id');
  return {
    checker,
    defaultMetaKey,
    metaValidators: collectMetaValidators(checker),
    createIsolatedCompiler: () => withRemotes(withFormats(construct(ISOLATED_COMPILER_OPTIONS))),
  };
};

const lazyDialect = (construct: (options: Options) => AjvCore): (() => Dialect) => {
  let dialect: Dialect | undefined;
  return () => {
    dialect ??= buildDialect(construct);
    return dialect;
  };
};

const draft07 = lazyDialect((options) => new Ajv.default(options));
const draft2020 = lazyDialect((options) => new Ajv2020.default(options));

const withoutEmptyFragment = (uri: string): string => (uri.endsWith('#') ? uri.slice(0, -1) : uri);

const metaValidatorFor = (dialect: Dialect, declared: string | undefined): ValidateFunction => {
  const key = declared === undefined || declared === '' ? dialect.defaultMetaKey : withoutEmptyFragment(declared);
  const validate = dialect.metaValidators.get(key);
  if (validate === undefined) throw new Error(`no schema with key or ref "${declared}"`);
  return validate;
};

const compileIsolated = (schema: Record<string, unknown>): ValidateFunction => {
  const declared = schema['$schema'];
  if (declared !== undefined && typeof declared !== 'string') throw new Error('$schema must be a string');
  const dialect = declared !== undefined && DRAFT_07.test(declared) ? draft07() : draft2020();
  const validateMeta = metaValidatorFor(dialect, declared);
  if (validateMeta(schema) !== true) throw new Error(`schema is invalid: ${dialect.checker.errorsText(validateMeta.errors)}`);
  return dialect.createIsolatedCompiler().compile(schema);
};

const keyOf = (schema: Record<string, unknown>): string => sha256Hex(canonicalJson(schema));

const remember = (key: string, entry: CacheEntry): void => {
  cache.set(key, entry);
  if (cache.size > MAX_CACHED_VALIDATORS) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
};

const resolve = (entry: CacheEntry): ValidateFunction => {
  if ('failure' in entry) throw new SchemaValidatorFailure(entry.failure);
  return entry.validate;
};

export const compileUntrustedSchema = (schema: Record<string, unknown>): ValidateFunction => {
  const key = keyOf(schema);
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
    return resolve(cached);
  }
  let entry: CacheEntry;
  try {
    entry = { validate: compileIsolated(schema) };
  } catch (error) {
    entry = { failure: cleanFailureMessage(error instanceof Error ? error.message : String(error)) };
  }
  remember(key, entry);
  return resolve(entry);
};

export const untrustedSchemaCacheSize = (): number => cache.size;

const validateFailures = new Map<string, string>();

const failureKeyOf = (identity: string, schema: Record<string, unknown>): string => `${identity}\u0000${keyOf(schema)}`;

export const recordValidateFailure = (identity: string, schema: Record<string, unknown>, message: string): void => {
  const key = failureKeyOf(identity, schema);
  validateFailures.delete(key);
  validateFailures.set(key, cleanFailureMessage(message));
  if (validateFailures.size > MAX_CACHED_VALIDATORS) {
    const oldest = validateFailures.keys().next();
    if (oldest.done !== true) validateFailures.delete(oldest.value);
  }
};

export const untrustedSchemaFailure = (identity: string, schema: Record<string, unknown>): string | undefined =>
  validateFailures.get(failureKeyOf(identity, schema));

export const clearUntrustedSchemaCaches = (): void => {
  cache.clear();
  validateFailures.clear();
  remoteSchemas.clear();
};
