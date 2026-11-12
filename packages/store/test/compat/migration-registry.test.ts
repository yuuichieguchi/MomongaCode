import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/schema.ts';

const STORE_TESTS = path.resolve(import.meta.dirname, '..');
const PINNED_RUN_LENGTH = 10;

const registryOrderProblem = (versions: readonly number[]): string | undefined => {
  for (const [index, version] of versions.entries()) {
    if (version !== index + 1) return `migration at position ${index + 1} has version ${version}; the registry runs 1, 2, 3, ... without a gap or repeat`;
  }
  return undefined;
};

const testFilesOf = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return testFilesOf(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });

const pinnedRunsOfLine = (line: string): string[] =>
  [...line.matchAll(/\[(\d+(?:, \d+)+)\]/g)].flatMap((match) => {
    const numbers = (match[1] ?? '').split(', ').map(Number);
    const consecutive = numbers.every((value, index) => index === 0 || value === (numbers[index - 1] ?? 0) + 1);
    return consecutive && numbers.length >= PINNED_RUN_LENGTH ? [match[0].slice(0, 40)] : [];
  });

const pinnedVersionRunsOf = (source: string): string[] =>
  source
    .split('\n')
    .filter((line) => line.includes('version'))
    .flatMap((line) => pinnedRunsOfLine(line));

describe('the migration registry is the one list of migrations', () => {
  it('runs from 1 without a gap or a repeat', () => {
    expect(registryOrderProblem(MIGRATIONS.map((migration) => migration.version))).toBeUndefined();
  });

  it('names a planted gap in a copy of the list', () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(registryOrderProblem([...versions.slice(0, 3), ...versions.slice(4)])).toMatch(/position 4 has version 5/);
  });

  it('no store test writes the version list out as numbers instead of reading the registry', () => {
    const pinned = testFilesOf(STORE_TESTS).flatMap((file) => pinnedVersionRunsOf(fs.readFileSync(file, 'utf8')).map((run) => `${path.relative(STORE_TESTS, file)}: ${run}`));
    expect(pinned).toEqual([]);
  });
});
