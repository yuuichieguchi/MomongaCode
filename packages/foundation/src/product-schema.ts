import { ataEngine } from './untrusted-engine.ts';
import { NO_REMOTE_DOCUMENTS } from './untrusted-schema.ts';
import type { RemoteDocuments, UntrustedError, UntrustedValidate } from './untrusted-schema.ts';
import { createUntrustedBoundary } from './validate-untrusted.ts';

export type ProductSchema = {
  readonly id: string;
  readonly schema: Record<string, unknown>;
  readonly remotes: RemoteDocuments;
};

export type ProductVerdict<T> = { readonly valid: true; readonly value: T } | { readonly valid: false; readonly errors: readonly UntrustedError[] };

export type ProductValidator<T> = (data: unknown) => ProductVerdict<T>;

type Boundary = ReturnType<typeof createUntrustedBoundary>;

const definitions = new Map<string, ProductSchema>();
const boundaries = new WeakMap<RemoteDocuments, Boundary>();

const boundaryFor = (remotes: RemoteDocuments): Boundary => {
  const known = boundaries.get(remotes);
  if (known !== undefined) return known;
  const created = createUntrustedBoundary({ remotes, engine: ataEngine });
  boundaries.set(remotes, created);
  return created;
};

const sameDefinition = (left: ProductSchema, right: ProductSchema): boolean => {
  if (JSON.stringify(left.schema) !== JSON.stringify(right.schema)) return false;
  if (left.remotes === right.remotes) return true;
  if (left.remotes.size !== right.remotes.size) return false;
  return [...left.remotes].every(([uri, document]) => right.remotes.get(uri) === document);
};

const register = (entry: ProductSchema): void => {
  const existing = definitions.get(entry.id);
  if (existing === undefined) {
    definitions.set(entry.id, entry);
    return;
  }
  if (!sameDefinition(existing, entry)) throw new Error(`product schema "${entry.id}" is already defined with a different schema`);
};

export const defineProductSchema = <T>(id: string, schema: Record<string, unknown>, remotes: RemoteDocuments = NO_REMOTE_DOCUMENTS): ProductValidator<T> => {
  if (id === '') throw new Error('a product schema needs a non-empty id');
  register({ id, schema, remotes });
  let compiled: UntrustedValidate | undefined;
  return (data) => {
    compiled ??= boundaryFor(remotes).compile(schema);
    const verdict = compiled(data);
    return verdict.valid ? { valid: true, value: data as T } : { valid: false, errors: verdict.errors };
  };
};

export const productSchemas = (): readonly ProductSchema[] => [...definitions.values()];

export const productErrorsText = (errors: readonly UntrustedError[], dataVar: string): string =>
  errors.length === 0 ? 'No errors' : errors.map((error) => `${dataVar}${error.instancePath} ${error.message}`).join(', ');
