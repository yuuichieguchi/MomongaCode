import { describe, expect, it } from 'vitest';
import * as testkit from '@momonga/testkit';
import { fileLevelTestTimeout, importsFromTestkit, perTestTimeouts, repositoryTests, timeoutKeys } from './support/test-timeout-source.ts';

const SEEDED_CALL = /\bseeded\(/;
const LOCAL_DECLARATION = /\b(?:const|let|var)\s+PROPERTY_TIMEOUT_MS\b/;
const FILE_LEVEL_FORM = /^testTimeout\s*:\s*PROPERTY_TIMEOUT_MS$/;

const propertyTests = (): Array<{ file: string; source: string }> =>
  repositoryTests().filter(({ file, source }) => SEEDED_CALL.test(source) && !file.startsWith('test/property-timeout-single-rule') && !file.startsWith('test/support/'));

const offendersOf = (file: string, source: string): string[] => {
  const reasons: string[] = [];
  if (!importsFromTestkit(source, 'PROPERTY_TIMEOUT_MS')) reasons.push('does not import PROPERTY_TIMEOUT_MS from @momonga/testkit');
  if (LOCAL_DECLARATION.test(source)) reasons.push('declares its own PROPERTY_TIMEOUT_MS');
  if (!fileLevelTestTimeout(source, 'PROPERTY_TIMEOUT_MS')) reasons.push('has no file-level vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS })');
  for (const key of timeoutKeys(source)) if (!FILE_LEVEL_FORM.test(key.trim())) reasons.push(`declares a timeout option: ${key.trim()}`);
  for (const timeout of perTestTimeouts(source)) reasons.push(`passes a per-test timeout: ${timeout}`);
  return reasons.map((reason) => `${file}: ${reason}`);
};

describe('every test that draws from seeded( takes PROPERTY_TIMEOUT_MS in one form: a file-level testTimeout', () => {
  it('testkit exports PROPERTY_TIMEOUT_MS as the 600 000 ms hang guard', () => {
    expect((testkit as Record<string, unknown>)['PROPERTY_TIMEOUT_MS']).toBe(600_000);
  });

  it('finds the property tests it guards', () => {
    expect(propertyTests().map((entry) => entry.file)).toEqual(
      expect.arrayContaining([
        'packages/context/test/one-input-one-decomposition-property.test.ts',
        'packages/context/test/eviction-pass-property.test.ts',
        'packages/gateway/test/dialect-soundness.test.ts',
        'packages/context/test/arrival-cache-cost.test.ts',
        'packages/context/test/budget.test.ts',
      ]),
    );
  });

  it.each([
    ['a number after the body', "it('x', () => {}, 600_000);"],
    ['an exponent literal after the body', "it('x', async () => {}, 6e5);"],
    ['the shared constant after the body', "it('x', () => {}, PROPERTY_TIMEOUT_MS);"],
    ['another identifier after the body', "test('x', () => {}, LONG);"],
    ['an expression after the body', "it('x', () => {}, 2 * BASE);"],
    ['an options object before the body', "it('x', { timeout: PROPERTY_TIMEOUT_MS }, () => {});"],
    ['a describe options object', "describe('x', { timeout: 1e4 }, () => {});"],
    ['an each table with a trailing timeout', "it.each([1, 2])('x %i', (n) => {}, 5000);"],
  ])('refuses %s', (_form, line) => {
    const source = `import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';\nvi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });\nseeded(1);\n${line}\n`;

    expect(offendersOf('fixture.test.ts', source)).not.toEqual([]);
  });

  it.each([
    ['a file-level testTimeout of another value', "vi.setConfig({ testTimeout: 600_000 });"],
    ['a file-level testTimeout of another identifier', "vi.setConfig({ testTimeout: LONG_MS });"],
  ])('refuses %s', (_form, line) => {
    const source = `import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';\n${line}\nseeded(1);\nit('x', () => {});\n`;

    expect(offendersOf('fixture.test.ts', source)).not.toEqual([]);
  });

  it('accepts the one form: a file-level testTimeout and no per-test timeout', () => {
    const source = [
      "import { PROPERTY_TIMEOUT_MS, seeded } from '@momonga/testkit';",
      'vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });',
      "describe('d', () => {",
      "  it('a', () => { seeded(1); }, );",
      "  it.each([1, 2])('b %i', (n) => { expect(n).toBeGreaterThan(0); });",
      "  it('c', async () => { await Promise.resolve({ value: 1 }); });",
      '});',
      '',
    ].join('\n');

    expect(offendersOf('fixture.test.ts', source)).toEqual([]);
  });

  it('every file that calls seeded( has the file-level PROPERTY_TIMEOUT_MS and no other timeout form', () => {
    expect(propertyTests().flatMap(({ file, source }) => offendersOf(file, source))).toEqual([]);
  });
});
