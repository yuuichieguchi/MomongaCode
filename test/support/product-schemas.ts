import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { productSchemas } from '@momonga/foundation';
import type { ProductSchema } from '@momonga/foundation';

export const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const packagesDir = path.join(repositoryRoot, 'packages');
export const PRODUCT_SCHEMA_DEFINITION = /\bdefineProductSchema\s*(?:<[^>()]*>)?\s*\(/;

const sourceFilesUnder = (directory: string): string[] => {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFilesUnder(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
};

export const runtimeSourceFiles = (): string[] =>
  fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => sourceFilesUnder(path.join(packagesDir, entry.name, 'src')))
    .sort();

export const productSchemaModules = (): string[] => runtimeSourceFiles().filter((file) => PRODUCT_SCHEMA_DEFINITION.test(fs.readFileSync(file, 'utf8')));

export const loadProductSchemas = async (): Promise<readonly ProductSchema[]> => {
  for (const file of productSchemaModules()) await import(pathToFileURL(file).href);
  return productSchemas();
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const SCHEMA_LIST_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SCHEMA_KEYWORDS = new Set(['items', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'contains', 'not', 'if', 'then', 'else']);
export const NON_STANDARD_KEYWORDS: readonly string[] = ['discriminator', 'nullable', 'components', 'example'];

export type KeywordSite = { readonly pointer: string; readonly keyword: string };

const escapeToken = (token: string): string => token.replaceAll('~', '~0').replaceAll('/', '~1');

export const keywordSites = (schema: unknown, keywords: readonly string[], pointer = ''): KeywordSite[] => {
  if (!isRecord(schema)) return [];
  const own = keywords.filter((keyword) => Object.hasOwn(schema, keyword)).map((keyword) => ({ pointer, keyword }));
  const nested = Object.entries(schema).flatMap(([key, value]) => {
    const at = `${pointer}/${escapeToken(key)}`;
    if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) return Object.entries(value).flatMap(([name, child]) => keywordSites(child, keywords, `${at}/${escapeToken(name)}`));
    if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) return value.flatMap((child, index) => keywordSites(child, keywords, `${at}/${index}`));
    if (SCHEMA_KEYWORDS.has(key)) return keywordSites(value, keywords, at);
    return [];
  });
  return [...own, ...nested];
};

export const exportedSchemaNames = (): { file: string; name: string }[] =>
  runtimeSourceFiles().flatMap((file) =>
    [...fs.readFileSync(file, 'utf8').matchAll(/^export const ([A-Z][A-Z0-9_]*_SCHEMA)\b/gm)].map((match) => ({ file, name: match[1] ?? '' })),
  );

const allSources = (): string => runtimeSourceFiles().map((file) => fs.readFileSync(file, 'utf8')).join('\n');

export const validatedSchemaNames = (names: readonly string[]): string[] => {
  const sources = allSources();
  return names.filter((name) => new RegExp(`\\b(?:compile|defineProductSchema)\\w*\\s*(?:<[^>()]*>)?\\(\\s*(?:'[^']*'\\s*,\\s*)?${name}\\b`).test(sources));
};

export const runApiSchemaReferences = (): string[] =>
  [...new Set(runtimeSourceFiles().flatMap((file) => [...fs.readFileSync(file, 'utf8').matchAll(/\bRUN_API_SCHEMAS\.(\w+)/g)].map((match) => match[1] ?? '')))].sort();

export const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
