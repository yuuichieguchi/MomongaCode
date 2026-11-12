import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const PACKAGES = path.resolve(import.meta.dirname, '..', 'packages');
const PRODUCER = /\bfitRank\s*:(?!\s*(?:number|readonly|string)\b)/;

const sourceFilesUnder = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'dist' ? [] : sourceFilesUnder(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

describe('the fit rank of a tool', () => {
  it('is produced in exactly one place, the registry comparator', () => {
    const producers = fs
      .readdirSync(PACKAGES)
      .map((name) => path.join(PACKAGES, name, 'src'))
      .filter((source) => fs.existsSync(source))
      .flatMap(sourceFilesUnder)
      .filter((file) => PRODUCER.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(PACKAGES, file));
    expect(producers).toEqual([path.join('tools', 'src', 'registry.ts')]);
  });
});
