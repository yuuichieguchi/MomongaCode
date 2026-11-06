import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { ataEngine, createUntrustedBoundary } from '@momonga/foundation';
import type { ProductSchema } from '@momonga/foundation';
import { OPEN_RESPONSES_OPENAPI, RUN_API_SCHEMAS } from '@momonga/protocol';
import {
  NON_STANDARD_KEYWORDS,
  exportedSchemaNames,
  keywordSites,
  loadProductSchemas,
  productSchemaModules,
  repositoryRoot,
  runApiSchemaReferences,
  sameJson,
  validatedSchemaNames,
} from './support/product-schemas.ts';

let loaded: Promise<readonly ProductSchema[]> | undefined;
const schemas = (): Promise<readonly ProductSchema[]> => (loaded ??= loadProductSchemas());

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const remoteDocumentsOf = (entry: ProductSchema): unknown[] => [...entry.remotes.values()];

const linterFor = (remotes: ProductSchema['remotes']): Ajv2020.default => {
  const ajv = new Ajv2020.default({ strict: true, allErrors: true });
  for (const [uri, document] of remotes) {
    if (isRecord(document)) ajv.addSchema(document, typeof document['$id'] === 'string' ? undefined : uri);
  }
  return ajv;
};

const strictLint = (entry: ProductSchema): string | undefined => {
  try {
    linterFor(entry.remotes).compile(entry.schema);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const componentNames = (): string[] => {
  const components = (OPEN_RESPONSES_OPENAPI as { components: { schemas: Record<string, unknown> } }).components;
  return Object.keys(components.schemas).sort();
};

describe('every product schema is standard JSON Schema 2020-12', () => {
  beforeAll(async () => {
    await schemas();
  });

  it('finds the modules that define product schemas by scanning every runtime source', () => {
    const relative = productSchemaModules().map((file) => path.relative(repositoryRoot, file));
    expect(relative.length).toBeGreaterThan(0);
  });

  it('enumerates product schemas with unique, non-empty identities', async () => {
    const entries = await schemas();
    expect(entries.length).toBeGreaterThan(0);
    const ids = entries.map((entry) => entry.id);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('enumerates every exported *_SCHEMA constant that a runtime source validates against', async () => {
    const entries = await schemas();
    const exported = exportedSchemaNames();
    const validated = new Set(validatedSchemaNames(exported.map(({ name }) => name)));
    expect(validated.size).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const { file, name } of exported.filter(({ name: candidate }) => validated.has(candidate))) {
      const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      if (!entries.some((entry) => sameJson(entry.schema, module[name]))) missing.push(`${path.relative(repositoryRoot, file)} ${name}`);
    }
    expect(missing).toEqual([]);
  });

  it('holds every exported *_SCHEMA constant to the same standard, validated or published', async () => {
    const problems: string[] = [];
    for (const { file, name } of exportedSchemaNames()) {
      const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      const schema = module[name];
      if (!isRecord(schema)) {
        problems.push(`${name}: not an object`);
        continue;
      }
      const entry: ProductSchema = { id: name, schema, remotes: new Map() };
      problems.push(...keywordSites(schema, NON_STANDARD_KEYWORDS).map((site) => `${name}#${site.pointer} ${site.keyword}`));
      const lint = strictLint(entry);
      if (lint !== undefined) problems.push(`${name}: ${lint}`);
      try {
        createUntrustedBoundary({ remotes: entry.remotes, engine: ataEngine }).compile(schema);
      } catch (error) {
        problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('enumerates every Run API schema a runtime source validates against', async () => {
    const entries = await schemas();
    const referenced = runApiSchemaReferences();
    expect(referenced).toEqual(expect.arrayContaining(['CreateRunRequest', 'PublicRunEvent', 'RunReflection', 'RunView']));
    const table = RUN_API_SCHEMAS as Record<string, unknown>;
    const missing = referenced.filter((name) => table[name] !== undefined && !entries.some((entry) => sameJson(entry.schema, table[name])));
    expect(missing).toEqual([]);
  });

  it('enumerates the Open Responses registry with an entry for every component', async () => {
    const entries = await schemas();
    const registries = entries.flatMap(remoteDocumentsOf).filter((document): document is Record<string, unknown> => isRecord(document) && isRecord(document['$defs']));
    const covering = registries.filter((registry) => sameJson(Object.keys(registry['$defs'] as Record<string, unknown>).sort(), componentNames()));
    expect(covering.length).toBeGreaterThan(0);
  });

  it('carries no discriminator, nullable, components or other non-standard keyword', async () => {
    const entries = await schemas();
    expect(entries.length).toBeGreaterThan(0);
    const sites = entries.flatMap((entry) => [
      ...keywordSites(entry.schema, NON_STANDARD_KEYWORDS).map((site) => `${entry.id}#${site.pointer} ${site.keyword}`),
      ...remoteDocumentsOf(entry).flatMap((document) => keywordSites(document, NON_STANDARD_KEYWORDS).map((site) => `${entry.id} remote#${site.pointer} ${site.keyword}`)),
    ]);
    expect([...new Set(sites)]).toEqual([]);
  });

  it('compiles every product schema through the foundation boundary', async () => {
    const entries = await schemas();
    expect(entries.length).toBeGreaterThan(0);
    const failures = entries.flatMap((entry) => {
      try {
        createUntrustedBoundary({ remotes: entry.remotes, engine: ataEngine }).compile(entry.schema);
        return [];
      } catch (error) {
        return [`${entry.id}: ${error instanceof Error ? error.message : String(error)}`];
      }
    });
    expect(failures).toEqual([]);
  });

  it('passes the Ajv strict-mode lint for every product schema', async () => {
    const entries = await schemas();
    expect(entries.length).toBeGreaterThan(0);
    const failures = entries.flatMap((entry) => {
      const problem = strictLint(entry);
      return problem === undefined ? [] : [`${entry.id}: ${problem}`];
    });
    expect(failures).toEqual([]);
  });
});

describe('the scanner that enumerates product schemas', () => {
  it('finds a non-standard keyword at any schema position but not a property named after it', () => {
    const schema = {
      type: 'object',
      properties: { nullable: { type: 'string' }, tag: { oneOf: [{ type: 'string', nullable: true }] } },
      $defs: { pet: { discriminator: { propertyName: 'kind' }, oneOf: [] } },
      items: { anyOf: [{ not: { example: 1 } }] },
    };
    expect(keywordSites(schema, NON_STANDARD_KEYWORDS)).toEqual([
      { pointer: '/properties/tag/oneOf/0', keyword: 'nullable' },
      { pointer: '/$defs/pet', keyword: 'discriminator' },
      { pointer: '/items/anyOf/0/not', keyword: 'example' },
    ]);
  });

  it('flags the Ajv-only keywords a product schema carries today', () => {
    expect(strictLint({ id: 'probe', schema: { type: 'object', properties: { reason: { type: 'string', nullable: true } } }, remotes: new Map() })).toBeUndefined();
    expect(keywordSites({ type: 'object', properties: { reason: { type: 'string', nullable: true } } }, NON_STANDARD_KEYWORDS)).toEqual([
      { pointer: '/properties/reason', keyword: 'nullable' },
    ]);
    expect(strictLint({ id: 'settings', schema: { type: 'object', discriminator: { propertyName: 'kind' }, oneOf: [{ type: 'object', properties: { kind: { const: 'a' } }, required: ['kind'] }] }, remotes: new Map() })).toMatch(/discriminator/);
  });
});
