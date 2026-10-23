import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalJson, sha256Hex } from '@momonga/foundation';

const MAX_CACHED_VALIDATORS = 512;
const DRAFT_07 = /^https?:\/\/json-schema\.org\/draft-07\/schema#?$/;
const OPTIONS = { strict: false, logger: false, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false } as const;

type CacheEntry = { validate: ValidateFunction } | { failure: string };

const cache = new Map<string, CacheEntry>();

const compileFresh = (schema: Record<string, unknown>): ValidateFunction => {
  const declared = schema['$schema'];
  const instance = typeof declared === 'string' && DRAFT_07.test(declared) ? new Ajv.default(OPTIONS) : new Ajv2020.default(OPTIONS);
  addFormats.default(instance);
  return instance.compile(schema);
};

const remember = (key: string, entry: CacheEntry): void => {
  cache.set(key, entry);
  if (cache.size > MAX_CACHED_VALIDATORS) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
};

const resolve = (entry: CacheEntry): ValidateFunction => {
  if ('failure' in entry) throw new Error(entry.failure);
  return entry.validate;
};

export const compileUntrustedSchema = (schema: Record<string, unknown>): ValidateFunction => {
  const key = sha256Hex(canonicalJson(schema));
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
    return resolve(cached);
  }
  let entry: CacheEntry;
  try {
    entry = { validate: compileFresh(schema) };
  } catch (error) {
    entry = { failure: error instanceof Error ? error.message : String(error) };
  }
  remember(key, entry);
  return resolve(entry);
};

export const untrustedSchemaCacheSize = (): number => cache.size;
