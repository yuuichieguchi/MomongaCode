import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANIFEST_FORMAT, everyRunColdSeconds, readManifest, tierBudgetProblem } from './manifest.ts';
import type { Manifest, ManifestEntry } from './manifest.ts';

const manifestPath = path.resolve(import.meta.dirname, '..', '..', 'specs', 'tla', 'manifest.json');

const entry = (config: string, tier: ManifestEntry['tier'], measuredSeconds: number): ManifestEntry => ({
  config,
  role: 'check',
  expect: 'holds',
  args: [],
  tier,
  distinctStates: 1,
  measuredSeconds,
  measuredCpuSeconds: 1,
  budgetCpuSeconds: 5,
});

const manifestOf = (unitSuiteSeconds: number, entries: readonly ManifestEntry[]): Manifest => ({ format: MANIFEST_FORMAT, unitSuiteSeconds, startupCpuSeconds: 3, entries });

const sample = manifestOf(20, [entry('A', 'every-run', 4.5), entry('A.deep', 'deep', 500), entry('B', 'every-run', 12), entry('C', 'every-run', 3.5)]);

const recordedRows = (): unknown[] => {
  const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('entries' in parsed) || !Array.isArray(parsed.entries)) throw new Error('the TLA manifest has no entries');
  return parsed.entries;
};

const reuseOf = (row: unknown): unknown => (typeof row === 'object' && row !== null && 'measuredReuse' in row ? row.measuredReuse : undefined);

describe('the cold wall of the every-run tier', () => {
  it('sums the measured wall seconds of the every-run entries only', () => {
    expect(everyRunColdSeconds(sample)).toBe(20);
  });

  it('accepts a cold wall equal to the unit suite wall time', () => {
    expect(tierBudgetProblem(sample)).toBeUndefined();
  });

  it('fails a cold wall over the unit suite wall time and names both', () => {
    const problem = tierBudgetProblem(manifestOf(20, [...sample.entries, entry('D', 'every-run', 0.5)]));
    expect(problem).toBe('the every-run rows take 20.5 s cold, over the unit suite wall time of 20 s');
  });

  it('does not count deep entries', () => {
    expect(tierBudgetProblem(manifestOf(20, [...sample.entries, entry('E.deep', 'deep', 10000)]))).toBeUndefined();
  });

  it('records every row as measured with reuse off', () => {
    expect(recordedRows().filter((row) => reuseOf(row) !== 'off')).toEqual([]);
  });

  it('keeps the cold wall of the recorded every-run rows within the recorded unit suite wall time', () => {
    const manifest = readManifest(manifestPath);
    expect(tierBudgetProblem(manifest)).toBeUndefined();
  });
});
