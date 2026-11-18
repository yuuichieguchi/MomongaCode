import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './support/source-scan.ts';

const SCAN_HELPERS = /from '\.\/support\/(source-scan|e2e-wait-scan|host-bounds-scan)\.ts'/;
const BOUNDED = "vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });";

const testFiles = (): string[] =>
  fs
    .readdirSync(path.join(ROOT, 'test'))
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => path.join('test', name));

describe('every test that scans the whole product source', () => {
  it('runs under the one source-scan test bound', () => {
    const unbounded = testFiles().filter((file) => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      return SCAN_HELPERS.test(text) && !text.includes(BOUNDED);
    });
    expect(unbounded).toEqual([]);
  });
});
