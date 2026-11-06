import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ataEngine, clearUntrustedSchemaCaches, createUntrustedBoundary, validateUntrusted } from '@momonga/foundation';

const SUITE = fileURLToPath(new URL('./fixtures/json-schema-test-suite/', import.meta.url));
const REMOTE_BASE = 'http://localhost:1234/';
const DRAFT_07_URI = 'http://json-schema.org/draft-07/schema#';
const SUITE_TIMEOUT_MS = 300_000;

type SuiteCase = { description: string; data: unknown; valid: boolean };
type SuiteGroup = { description: string; schema: unknown; tests: SuiteCase[] };
type Outcome = { total: number; failures: string[]; throws: string[] };

const walk = (directory: string): string[] =>
  readdirSync(directory)
    .sort()
    .flatMap((entry) => {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return entry.endsWith('.json') ? [full] : [];
    });

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8')) as unknown;

const OFFICIAL_META_BASE = 'https://json-schema.org/draft/2020-12/meta/';

const remotes = (): Record<string, unknown> => {
  const root = path.join(SUITE, 'remotes');
  const metaRoot = path.join(SUITE, 'metaschemas', 'draft2020-12', 'meta');
  return {
    ...Object.fromEntries(walk(root).map((file) => [REMOTE_BASE + path.relative(root, file).split(path.sep).join('/'), readJson(file)])),
    ...Object.fromEntries(walk(metaRoot).map((file) => [OFFICIAL_META_BASE + path.basename(file, '.json'), readJson(file)])),
  };
};

const asDraft07 = (schema: unknown): unknown => {
  if (typeof schema !== 'object' || schema === null || '$schema' in schema) return schema;
  return { ...schema, $schema: DRAFT_07_URI };
};

const suiteBoundary = createUntrustedBoundary({ remotes: new Map(Object.entries(remotes())), engine: ataEngine });

const runGroups = (label: string, groups: readonly SuiteGroup[], prepare: (schema: unknown) => unknown): Outcome => {
  const outcome: Outcome = { total: 0, failures: [], throws: [] };
  groups.forEach((group, index) => {
    const schema = prepare(group.schema) as Record<string, unknown>;
    for (const test of group.tests) {
      outcome.total += 1;
      const name = `${label} > ${group.description} > ${test.description}`;
      try {
        const verdict = suiteBoundary.validate(`suite:${label}:${index}`, schema, structuredClone(test.data));
        if (verdict.valid !== test.valid) outcome.failures.push(name);
      } catch (error) {
        outcome.throws.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        outcome.failures.push(name);
      }
    }
  });
  return outcome;
};

const runDraft = (directory: string, prepare: (schema: unknown) => unknown): Outcome => {
  const root = path.join(SUITE, 'tests', directory);
  const total: Outcome = { total: 0, failures: [], throws: [] };
  for (const file of walk(root)) {
    const label = `${directory}/${path.relative(root, file).replace(/\.json$/, '')}`;
    const outcome = runGroups(label, readJson(file) as SuiteGroup[], prepare);
    total.total += outcome.total;
    total.failures.push(...outcome.failures);
    total.throws.push(...outcome.throws);
  }
  return total;
};

type Selection = 'all' | 'expected-invalid' | readonly string[];
type Exception = { readonly file: string; readonly tests: Selection; readonly reason: string };

const FORMAT_FILES = ['date-time', 'date', 'duration', 'ecmascript-regex', 'email', 'hostname', 'idn-email', 'idn-hostname', 'ipv4', 'ipv6', 'iri-reference', 'iri', 'json-pointer', 'regex', 'relative-json-pointer', 'time', 'uri-reference', 'uri-template', 'uri', 'uuid'];

const FORMAT_REASON =
  'format is an annotation in the product: the engine runs with assertFormat:false (packages/foundation/src/untrusted-engine.ts OPTIONS). Draft 2020-12 Validation section 7.2.1 makes the format-annotation vocabulary the default, and section 7.2.1 says assertion is optional ("MAY"). The files under optional/format check assertion, so only the tests that expect a rejection are left out; every test that expects acceptance still runs. The required format.json, which expects annotation, passes.';

const EXCEPTIONS: readonly Exception[] = [
  ...FORMAT_FILES.map((name): Exception => ({ file: `optional/format/${name}`, tests: 'expected-invalid', reason: FORMAT_REASON })),
  {
    file: 'optional/dependencies-compatibility',
    tests: 'expected-invalid',
    reason:
      'dependencies is not a keyword of draft 2020-12: Core 2020-12 section 8.2.4 lists dependentRequired and dependentSchemas in its place, and the suite itself marks this file optional compatibility. The product accepts draft 2020-12 and draft-07 (packages/foundation/src/untrusted-dialect.ts), and dependencies is covered for draft-07 by the required draft7/dependencies.json.',
  },
  {
    file: 'optional/cross-draft',
    tests: 'all',
    reason:
      'a $ref into a draft 2019-09 document is not supported: the product accepts only draft 2020-12, draft-07 and supplied documents of those two (packages/foundation/src/untrusted-schema.ts, the error "is not draft 2020-12, draft-07 or a supplied document").',
  },
];

const selectedNames = (list: readonly Exception[]): Map<string, string> => {
  const names = new Map<string, string>();
  for (const entry of list) {
    const file = `draft2020-12/${entry.file}`;
    const groups = readJson(path.join(SUITE, 'tests', `${file}.json`)) as SuiteGroup[];
    for (const group of groups) {
      for (const test of group.tests) {
        const chosen = entry.tests === 'all' || (entry.tests === 'expected-invalid' ? !test.valid : entry.tests.includes(test.description) || entry.tests.includes(`${group.description} > ${test.description}`));
        if (chosen) names.set(`${file} > ${group.description} > ${test.description}`, entry.reason);
      }
    }
    if (Array.isArray(entry.tests)) {
      const found = groups.flatMap((group) => group.tests.flatMap((test) => [test.description, `${group.description} > ${test.description}`]));
      expect(entry.tests.filter((description) => !found.includes(description)), `${entry.file} names a test that does not exist`).toEqual([]);
    }
  }
  return names;
};

const summary = (outcome: Outcome) => ({ fail: outcome.failures.length, throw: outcome.throws.length, failures: outcome.failures, throws: outcome.throws });

describe('the vendored official JSON Schema Test Suite', () => {
  it('is pinned to the measured commit and carries its license', () => {
    expect(readFileSync(path.join(SUITE, 'COMMIT'), 'utf8').trim()).toBe('245a45abc90190c0bff04d97e6d2b541b4bb9f12');
    expect(readFileSync(path.join(SUITE, 'LICENSE'), 'utf8')).toContain('Permission is hereby granted');
  });
});

describe('every test of the official suite through the untrusted-schema boundary', () => {
  it(
    'answers all 2374 draft 2020-12 tests (1300 required, 1074 optional) correctly, except the listed ones',
    () => {
      const outcome = runDraft('draft2020-12', (schema) => schema);
      expect(outcome.total).toBe(2374);
      const excepted = selectedNames(EXCEPTIONS);
      const failed = new Set(outcome.failures);
      expect({
        unexpectedFailures: outcome.failures.filter((name) => !excepted.has(name)),
        exceptionsThatNowPass: [...excepted.keys()].filter((name) => !failed.has(name)),
      }).toEqual({ unexpectedFailures: [], exceptionsThatNowPass: [] });
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'passes all 927 required draft-07 tests with no throw',
    () => {
      const outcome = runDraft('draft7', asDraft07);
      expect(outcome.total).toBe(927);
      expect(summary(outcome)).toEqual({ fail: 0, throw: 0, failures: [], throws: [] });
    },
    SUITE_TIMEOUT_MS,
  );
});

const verdictOf = (identity: string, schema: unknown, data: unknown): boolean => validateUntrusted(identity, schema as Record<string, unknown>, data).valid;

describe('open item 26 cases through the untrusted-schema boundary', () => {
  const crashObject = { type: 'object', if: { anyOf: [{ properties: { a: {} } }], not: {} }, then: false };
  const crashItems = { type: 'array', if: { anyOf: [{ items: {} }], not: {} }, then: false };
  const crashPrefixItems = { type: 'array', if: { anyOf: [{ prefixItems: [{}] }], not: {} }, then: false };
  const ifThenEmpty = { if: { unevaluatedProperties: {} }, then: {}, unevaluatedProperties: false };

  it.each([
    ['crash 1, object form', {}, true, crashObject],
    ['crash 1, object form', { a: 1 }, true, crashObject],
    ['crash 1, object form', [], false, crashObject],
    ['crash 2, items form', [], true, crashItems],
    ['crash 2, items form', [1], true, crashItems],
    ['crash 2, items form', {}, false, crashItems],
    ['crash 2, prefixItems form', [], true, crashPrefixItems],
    ['crash 2, prefixItems form', [1], true, crashPrefixItems],
    ['crash 2, prefixItems form', {}, false, crashPrefixItems],
    ['if with then {}', { a: null }, true, ifThenEmpty],
  ])('%s: %j is valid=%s with no throw', (_label, data, expected, schema) => {
    clearUntrustedSchemaCaches();
    expect(verdictOf('item26', schema, data)).toBe(expected);
  });
});

describe('trivial contains with unevaluatedItems through the untrusted-schema boundary', () => {
  const emptyContains = { contains: {}, unevaluatedItems: false };
  const trueContains = { contains: true, unevaluatedItems: false };
  const nestedRef = { properties: { r: { $ref: '#/$defs/d2' } }, $defs: { d2: { unevaluatedItems: false, contains: {} } } };
  const nullContains = { contains: { type: 'null' }, unevaluatedItems: false };

  it.each([
    ['contains {}', [null], true, emptyContains],
    ['contains {}', [1, 2], true, emptyContains],
    ['contains {}', [], false, emptyContains],
    ['contains true', [null], true, trueContains],
    ['contains {} behind a $ref', { r: [null] }, true, nestedRef],
    ['contains null type, control', [null], true, nullContains],
  ])('%s: %j is valid=%s', (_label, data, expected, schema) => {
    clearUntrustedSchemaCaches();
    expect(verdictOf('contains-unevaluated', schema, data)).toBe(expected);
  });
});
