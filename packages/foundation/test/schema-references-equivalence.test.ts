import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Validator } from 'ata-validator/lite';
import { describe, expect, it } from 'vitest';
import { SchemaValidatorFailure, ataEngine, createUntrustedBoundary } from '@momonga/foundation';

const require = createRequire(import.meta.url);
const ataLib = path.join(path.dirname(require.resolve('ata-validator/package.json')), 'lib');

type RefInternals = {
  indexSchemas(root: unknown, schemaMap: Map<string, unknown> | null, flat: boolean): { nodeBase: Map<unknown, string> };
  resolveRef(ref: string, base: string, state: unknown): { node: unknown };
};

const internals = (require(path.join(ataLib, 'interpreter-core.js')) as { _refInternals: RefInternals })._refInternals;

const SUITE = fileURLToPath(new URL('./fixtures/json-schema-test-suite/', import.meta.url));
const REMOTE_BASE = 'http://localhost:1234/';
const DRAFT_07_URI = 'http://json-schema.org/draft-07/schema#';
const REFERENCE_KEYWORDS = ['$ref', '$dynamicRef'] as const;

const walk = (directory: string): string[] =>
  readdirSync(directory)
    .sort()
    .flatMap((entry) => {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return entry.endsWith('.json') ? [full] : [];
    });

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8')) as unknown;

const suiteRemotes = (): Map<string, unknown> => {
  const root = path.join(SUITE, 'remotes');
  return new Map(walk(root).map((file) => [REMOTE_BASE + path.relative(root, file).split(path.sep).join('/'), readJson(file)]));
};

const registryOf = (remotes: ReadonlyMap<string, unknown>): Record<string, object> =>
  Object.fromEntries(
    [...remotes].flatMap(([uri, document]) => {
      if (typeof document !== 'object' || document === null) return [];
      const record = document as Record<string, unknown>;
      return [[uri, '$id' in record || Array.isArray(record) ? record : { ...record, $id: uri }]];
    }),
  );

const oracleUnresolved = (schema: Record<string, unknown>, remotes: ReadonlyMap<string, unknown>): boolean => {
  const validator = new Validator(structuredClone(schema), {
    engine: 'interpreter',
    useDefaults: false,
    assertFormat: false,
    schemas: registryOf(new Map([...remotes].map(([uri, document]) => [uri, structuredClone(document)]))),
  }) as unknown as { engine(): string; _schemaObj: unknown; _schemaMap: Map<string, unknown> };
  validator.engine();
  const normalized = validator._schemaObj;
  const map = validator._schemaMap.size > 0 ? validator._schemaMap : null;
  const own = internals.indexSchemas(normalized, null, false);
  const full = internals.indexSchemas(normalized, map, false);
  for (const [node, base] of own.nodeBase) {
    if (typeof node !== 'object' || node === null) continue;
    for (const keyword of REFERENCE_KEYWORDS) {
      const reference = (node as Record<string, unknown>)[keyword];
      if (typeof reference === 'string' && internals.resolveRef(reference, base, full).node === undefined) return true;
    }
  }
  return false;
};

type Verdict = 'unresolvable' | 'resolvable' | 'refused';

const boundaryVerdict = (schema: Record<string, unknown>, remotes: ReadonlyMap<string, unknown>): Verdict => {
  try {
    createUntrustedBoundary({ remotes, engine: ataEngine }).compile(schema);
    return 'resolvable';
  } catch (error) {
    if (!(error instanceof SchemaValidatorFailure)) throw error;
    return /cannot be resolved/.test(error.message) ? 'unresolvable' : 'refused';
  }
};

const compare = (schema: Record<string, unknown>, remotes: ReadonlyMap<string, unknown>): { expected: Verdict; actual: Verdict } => {
  const actual = boundaryVerdict(schema, remotes);
  return { expected: actual === 'refused' ? 'refused' : oracleUnresolved(schema, remotes) ? 'unresolvable' : 'resolvable', actual };
};

const GENERATED_TIMEOUT_MS = 120_000;
const NO_REMOTES: ReadonlyMap<string, unknown> = new Map();

describe('the reference check at the boundary against ata\'s own resolver', () => {
  it.each([
    ['a $dynamicRef that names nothing', { $dynamicRef: '#nope' }, 'unresolvable'],
    ['the base the engine registers a schema without $id under', { $defs: { a: { type: 'string' } }, $ref: 'ata://root#/$defs/a' }, 'resolvable'],
    ['a synthetic host nobody registers', { $defs: { a: { type: 'string' } }, $ref: 'http://momonga.invalid/root#/$defs/a' }, 'unresolvable'],
    ['a draft-07 anchor in definitions beside a root $ref', { $schema: DRAFT_07_URI, definitions: { a: { $id: '#foo', type: 'string' } }, $ref: '#foo' }, 'resolvable'],
    ['a draft-07 full-URI $id in definitions beside a root $ref', { $schema: DRAFT_07_URI, definitions: { a: { $id: 'http://e/a', type: 'string' } }, $ref: 'http://e/a' }, 'resolvable'],
  ] as const)('%s', (_label, schema, expected) => {
    const verdict = compare(schema as Record<string, unknown>, NO_REMOTES);
    expect(verdict.expected).toBe(expected);
    expect(verdict.actual).toBe(expected);
  });

  it('agrees on every group of the vendored suite that uses $ref, $dynamicRef, $id or $anchor', () => {
    const remotes = suiteRemotes();
    const disagreements: string[] = [];
    let compared = 0;
    for (const [directory, prepare] of [
      ['draft2020-12', (schema: Record<string, unknown>) => schema],
      ['draft7', (schema: Record<string, unknown>) => ('$schema' in schema ? schema : { ...schema, $schema: DRAFT_07_URI })],
    ] as const) {
      const root = path.join(SUITE, 'tests', directory);
      for (const file of walk(root)) {
        for (const group of readJson(file) as { description: string; schema: unknown }[]) {
          const text = JSON.stringify(group.schema);
          if (typeof group.schema !== 'object' || group.schema === null || !/"\$(ref|dynamicRef|id|anchor|dynamicAnchor)"/.test(text)) continue;
          const verdict = compare(prepare(group.schema as Record<string, unknown>), remotes);
          if (verdict.expected === 'refused') continue;
          compared += 1;
          if (verdict.expected !== verdict.actual) disagreements.push(`${directory}/${path.relative(root, file)} > ${group.description}: oracle ${verdict.expected}, boundary ${verdict.actual}`);
        }
      }
    }
    expect(compared).toBeGreaterThan(100);
    expect(disagreements).toEqual([]);
  }, GENERATED_TIMEOUT_MS);

  it('agrees on at least 500 seeded schemas with references into $defs, definitions, $id scopes, anchors, relative URIs, pointer escapes and non-schema keywords', () => {
    const disagreements: string[] = [];
    let compared = 0;
    let unresolvable = 0;
    let resolvable = 0;
    for (let seed = 1; seed <= 3000 && compared < 1500; seed += 1) {
      const schema = generateSchema(mulberry32(seed));
      const verdict = compare(schema, NO_REMOTES);
      if (verdict.expected === 'refused') continue;
      compared += 1;
      if (verdict.expected === 'unresolvable') unresolvable += 1;
      else resolvable += 1;
      if (verdict.expected !== verdict.actual) disagreements.push(`seed ${seed}: oracle ${verdict.expected}, boundary ${verdict.actual}: ${JSON.stringify(schema)}`);
    }
    expect(compared).toBeGreaterThanOrEqual(500);
    expect(unresolvable).toBeGreaterThanOrEqual(100);
    expect(resolvable).toBeGreaterThanOrEqual(100);
    expect(disagreements.slice(0, 5)).toEqual([]);
  }, GENERATED_TIMEOUT_MS);
});

const mulberry32 = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const META_REFERENCES = [
  'https://json-schema.org/draft/2020-12/meta/validation#/$defs/simpleTypes',
  'https://json-schema.org/draft/2020-12/meta/validation#/$defs/nope',
  'https://json-schema.org/draft/2020-12/schema',
  'https://json-schema.org/draft/2020-12/schema#/$defs/nope',
  'http://json-schema.org/draft-07/schema#/definitions/simpleTypes',
  'http://json-schema.org/draft-07/schema#/definitions/nope',
  'http://json-schema.org/draft-07/schema#',
];
const IDS = ['http://e.example/a', 'http://e.example/b/', 'urn:x:y', 'sub/c.json', 'd.json', 'http://e.example/a/e.json'];
const ANCHORS = ['A', 'B', 'foo'];
const KEYS = ['a', 'b', 'a/b', 'c d'];

const generateSchema = (rng: () => number): Record<string, unknown> => {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;
  const chance = (probability: number): boolean => rng() < probability;
  const draft07 = chance(0.4);
  const defsKeyword = draft07 && chance(0.7) ? 'definitions' : '$defs';
  const escape = (key: string): string => key.replaceAll('~', '~0').replaceAll('/', '~1');

  const reference = (): string => {
    const key = pick(KEYS);
    const id = pick(IDS);
    return pick([
      '#',
      `#/${defsKeyword}/${escape(key)}`,
      `#/${pick(['$defs', 'definitions'])}/${escape(key)}`,
      `#/${defsKeyword}/${encodeURIComponent(key)}`,
      `#/${defsKeyword}/${escape(key)}/properties/p`,
      '#/properties/p',
      '#/properties/p/items',
      `#${pick(ANCHORS)}`,
      `#/${pick(['enum/0', 'x-unknown/y', 'required/0', 'properties/q', 'allOf/1'])}`,
      id,
      `${id}#`,
      `${id}#/${defsKeyword}/${escape(key)}`,
      `${id}#${pick(ANCHORS)}`,
      `ata://root#/${defsKeyword}/${escape(key)}`,
      'http://momonga.invalid/root#',
      `#/${defsKeyword}/${escape(key)}/${defsKeyword}/${escape(pick(KEYS))}`,
      pick(META_REFERENCES),
    ]);
  };

  const node = (depth: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (chance(0.25)) out['type'] = 'object';
    if (chance(0.3)) out['$id'] = pick(draft07 && chance(0.4) ? ['#A', '#B', '#foo', ...IDS] : IDS);
    if (!draft07 && chance(0.25)) out[pick(['$anchor', '$dynamicAnchor'])] = pick(ANCHORS);
    if (chance(0.45)) out['$ref'] = reference();
    if (!draft07 && chance(0.15)) out['$dynamicRef'] = reference();
    if (depth > 0) {
      if (chance(0.5)) out['properties'] = { p: node(depth - 1), ...(chance(0.4) ? { q: node(depth - 1) } : {}) };
      if (chance(0.25)) out['items'] = node(depth - 1);
      if (chance(0.2)) out['allOf'] = [node(depth - 1), node(depth - 1)];
      if (chance(0.15)) out['anyOf'] = [node(depth - 1)];
      if (chance(0.2)) out[defsKeyword] = Object.fromEntries(KEYS.filter(() => chance(0.5)).map((key) => [key, node(depth - 1)]));
      if (chance(0.1)) out['enum'] = [{ $ref: '#/nothing', $id: 'http://z.example/' }];
      if (chance(0.1)) out['x-unknown'] = { y: { $ref: '#/elsewhere' }, $id: 'http://hidden.example/' };
      if (chance(0.1)) out['required'] = ['p'];
    }
    return out;
  };

  const root = node(3);
  if (draft07) root['$schema'] = DRAFT_07_URI;
  if (chance(0.5)) root[defsKeyword] = { ...(root[defsKeyword] as object | undefined), ...Object.fromEntries(KEYS.filter(() => chance(0.6)).map((key) => [key, node(2)])) };
  if (chance(0.4)) root['$id'] = pick(IDS);
  return root;
};
