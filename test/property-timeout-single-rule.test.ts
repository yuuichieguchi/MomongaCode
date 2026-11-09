import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as testkit from '@momonga/testkit';

const ROOT = path.resolve(import.meta.dirname, '..');

const testFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(full);
    return entry.name.endsWith('.test.ts') ? [full] : [];
  });

const repositoryTests = (): string[] => [
  ...fs
    .readdirSync(path.join(ROOT, 'packages'))
    .map((name) => path.join(ROOT, 'packages', name, 'test'))
    .filter((dir) => fs.existsSync(dir))
    .flatMap(testFiles),
  ...testFiles(path.join(ROOT, 'test')),
];

const SEEDED_CALL = /\bseeded\(/;
const SHARED_IMPORT = /import\s*\{[^}]*\bPROPERTY_TIMEOUT_MS\b[^}]*\}\s*from\s*'@momonga\/testkit'/;
const LOCAL_DECLARATION = /\b(?:const|let|var)\s+PROPERTY_TIMEOUT_MS\b/;
const NUMERIC_TIMEOUT = /\btimeout\s*:\s*\d|testTimeout\s*:\s*\d|\}\s*,\s*\d[\d_]{3,}\s*\)/;
const TIMEOUT_USE = /,\s*PROPERTY_TIMEOUT_MS\s*\)|\btimeout\s*:\s*PROPERTY_TIMEOUT_MS\b|testTimeout\s*:\s*PROPERTY_TIMEOUT_MS\b/;

const relative = (file: string): string => path.relative(ROOT, file);

const propertyTests = (): Array<{ file: string; source: string }> =>
  repositoryTests()
    .map((file) => ({ file: relative(file), source: fs.readFileSync(file, 'utf8') }))
    .filter(({ file, source }) => SEEDED_CALL.test(source) && !file.endsWith('property-timeout-single-rule.test.ts'));

describe('every test that loops over generated cases takes the one shared PROPERTY_TIMEOUT_MS', () => {
  it('testkit exports PROPERTY_TIMEOUT_MS as the 600 000 ms hang guard', () => {
    expect((testkit as Record<string, unknown>)['PROPERTY_TIMEOUT_MS']).toBe(600_000);
  });

  it('finds the property tests it guards', () => {
    const files = propertyTests().map((entry) => entry.file);
    expect(files).toEqual(
      expect.arrayContaining([
        'packages/context/test/one-input-one-decomposition-property.test.ts',
        'packages/context/test/eviction-pass-property.test.ts',
        'packages/gateway/test/dialect-soundness.test.ts',
        'packages/context/test/arrival-cache-cost.test.ts',
        'packages/context/test/budget.test.ts',
      ]),
    );
  });

  it('every file that calls seeded( imports PROPERTY_TIMEOUT_MS from testkit, passes it as a timeout, and declares no timeout of its own', () => {
    const offenders = propertyTests().flatMap(({ file, source }) => {
      const reasons: string[] = [];
      if (!SHARED_IMPORT.test(source)) reasons.push('does not import PROPERTY_TIMEOUT_MS from @momonga/testkit');
      if (LOCAL_DECLARATION.test(source)) reasons.push('declares its own PROPERTY_TIMEOUT_MS');
      if (!TIMEOUT_USE.test(source)) reasons.push('never passes PROPERTY_TIMEOUT_MS as a timeout');
      if (NUMERIC_TIMEOUT.test(source)) reasons.push('passes a numeric timeout');
      return reasons.map((reason) => `${file}: ${reason}`);
    });
    expect(offenders).toEqual([]);
  });
});
