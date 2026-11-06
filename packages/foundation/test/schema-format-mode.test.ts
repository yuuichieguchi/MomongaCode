import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ataEngine, createUntrustedBoundary } from '@momonga/foundation';

const SUITE = fileURLToPath(new URL('./fixtures/json-schema-test-suite/', import.meta.url));
const OFFICIAL_META_BASE = 'https://json-schema.org/draft/2020-12/meta/';
const STANDARD_META = 'https://json-schema.org/draft/2020-12/schema';
const FORMAT_ASSERTION_VOCABULARY = 'https://json-schema.org/draft/2020-12/vocab/format-assertion';

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8')) as unknown;

const metaDeclaring = (id: string, assertion: boolean): Record<string, unknown> => ({
  $id: id,
  $schema: STANDARD_META,
  $vocabulary: {
    'https://json-schema.org/draft/2020-12/vocab/core': true,
    'https://json-schema.org/draft/2020-12/vocab/applicator': true,
    'https://json-schema.org/draft/2020-12/vocab/validation': true,
    [FORMAT_ASSERTION_VOCABULARY]: assertion,
  },
  $dynamicAnchor: 'meta',
  allOf: [
    { $ref: `${OFFICIAL_META_BASE}core` },
    { $ref: `${OFFICIAL_META_BASE}applicator` },
    { $ref: `${OFFICIAL_META_BASE}validation` },
    { $ref: `${OFFICIAL_META_BASE}format-assertion` },
  ],
});

const ASSERTING_TRUE = 'https://meta.example.test/strict-true';
const ASSERTING_FALSE = 'https://meta.example.test/strict-false';

const officialMeta = (): [string, unknown][] => {
  const root = path.join(SUITE, 'metaschemas', 'draft2020-12', 'meta');
  return readdirSync(root)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => [OFFICIAL_META_BASE + path.basename(entry, '.json'), readJson(path.join(root, entry))]);
};

const newBoundary = () =>
  createUntrustedBoundary({
    remotes: new Map<string, unknown>([...officialMeta(), [ASSERTING_TRUE, metaDeclaring(ASSERTING_TRUE, true)], [ASSERTING_FALSE, metaDeclaring(ASSERTING_FALSE, false)]]),
    engine: ataEngine,
  });

const underMeta = (meta: string, schema: Record<string, unknown>): Record<string, unknown> => ({ ...schema, $schema: meta });

describe('format is asserted per schema, by the format-assertion vocabulary of its meta-schema', () => {
  it.each([
    ['ipv4', 'not-an-ipv4', '127.0.0.1'],
    ['email', 'no-at-sign', 'joe@example.com'],
    ['date', '2026-13-40', '2026-11-06'],
    ['uuid', 'not-a-uuid', '2eb8aa08-aa98-11ea-b4aa-73b441d16380'],
  ])('format %s: a meta-schema declaring format-assertion true or false rejects %j and accepts %j', (format, invalid, valid) => {
    const boundary = newBoundary();
    for (const meta of [ASSERTING_TRUE, ASSERTING_FALSE]) {
      const schema = underMeta(meta, { type: 'string', format });
      expect({ meta, invalid: boundary.validate(`format-mode:${meta}`, schema, invalid).valid, valid: boundary.validate(`format-mode:${meta}`, schema, valid).valid }).toEqual({ meta, invalid: false, valid: true });
    }
  });

  it.each([['ipv4', 'not-an-ipv4'], ['email', 'no-at-sign'], ['date', '2026-13-40'], ['uuid', 'not-a-uuid']])('format %s under the standard meta-schema stays an annotation and accepts %j', (format, invalid) => {
    const boundary = newBoundary();
    expect(boundary.validate('format-mode:standard', underMeta(STANDARD_META, { type: 'string', format }), invalid).valid).toBe(true);
    expect(boundary.validate('format-mode:none', { type: 'string', format }, invalid).valid).toBe(true);
  });

  it('one boundary keeps both modes apart, whichever schema it compiles first', () => {
    const annotationFirst = newBoundary();
    expect(annotationFirst.validate('order:a', underMeta(STANDARD_META, { format: 'ipv4' }), 'x').valid).toBe(true);
    expect(annotationFirst.validate('order:b', underMeta(ASSERTING_TRUE, { format: 'ipv4' }), 'x').valid).toBe(false);
    expect(annotationFirst.validate('order:c', underMeta(STANDARD_META, { format: 'ipv4' }), 'x').valid).toBe(true);
    const assertionFirst = newBoundary();
    expect(assertionFirst.validate('order:d', underMeta(ASSERTING_FALSE, { format: 'ipv4' }), 'x').valid).toBe(false);
    expect(assertionFirst.validate('order:e', underMeta(STANDARD_META, { format: 'ipv4' }), 'x').valid).toBe(true);
  });

  it('a subschema reached by $ref from an asserting schema is asserted', () => {
    const boundary = newBoundary();
    const schema = underMeta(ASSERTING_TRUE, { properties: { address: { $ref: '#/$defs/address' } }, $defs: { address: { type: 'string', format: 'ipv4' } } });
    expect(boundary.validate('format-mode:ref', schema, { address: 'not-an-ipv4' }).valid).toBe(false);
    expect(boundary.validate('format-mode:ref', schema, { address: '10.0.0.1' }).valid).toBe(true);
  });
});

type SuiteCase = { description: string; data: unknown; valid: boolean };
type SuiteGroup = { description: string; schema: Record<string, unknown>; tests: SuiteCase[] };

describe.each(['hostname', 'idn-hostname'])('optional/format/%s.json with format asserted', (name) => {
  it('answers every test as the suite expects', () => {
    const groups = readJson(path.join(SUITE, 'tests', 'draft2020-12', 'optional', 'format', `${name}.json`)) as SuiteGroup[];
    const boundary = newBoundary();
    const wrong: string[] = [];
    let total = 0;
    groups.forEach((group, index) => {
      const schema = underMeta(ASSERTING_TRUE, group.schema);
      for (const test of group.tests) {
        total += 1;
        let actual: boolean | string;
        try {
          actual = boundary.validate(`${name}:${index}`, schema, structuredClone(test.data)).valid;
        } catch (error) {
          actual = `threw: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (actual !== test.valid) wrong.push(`${group.description} > ${test.description}: expected ${test.valid}, got ${String(actual)}`);
      }
    });
    expect(total).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  });
});
