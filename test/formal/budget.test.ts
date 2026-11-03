import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANIFEST_FORMAT, everyRunBudgetSeconds, readManifest, tierBudgetProblem } from './manifest.ts';
import type { Manifest, ManifestEntry } from './manifest.ts';

const manifestPath = path.resolve(import.meta.dirname, '..', '..', 'specs', 'tla', 'manifest.json');

const entry = (config: string, tier: ManifestEntry['tier'], budgetSeconds: number): ManifestEntry => ({
  config,
  role: 'check',
  expect: 'holds',
  args: [],
  tier,
  distinctStates: 1,
  measuredSeconds: budgetSeconds / 2,
  budgetSeconds,
});

const manifestOf = (unitSuiteSeconds: number, entries: readonly ManifestEntry[]): Manifest => ({ format: MANIFEST_FORMAT, unitSuiteSeconds, entries });

const sample = manifestOf(40, [entry('A', 'every-run', 10), entry('A.deep', 'deep', 500), entry('B', 'every-run', 14), entry('C', 'every-run', 16)]);

describe('the time budget of the every-run tier', () => {
  it('sums the budgets of the every-run entries only', () => {
    expect(everyRunBudgetSeconds(sample)).toBe(40);
  });

  it('accepts a sum equal to unitSuiteSeconds', () => {
    expect(tierBudgetProblem(sample)).toBeUndefined();
  });

  it('fails a sum one second over unitSuiteSeconds and names both numbers', () => {
    const over = manifestOf(40, [...sample.entries, entry('D', 'every-run', 1)]);
    const problem = tierBudgetProblem(over);
    expect(problem).toBeDefined();
    expect(problem).toContain('41');
    expect(problem).toContain('40');
  });

  it('does not count deep entries against the total', () => {
    expect(tierBudgetProblem(manifestOf(40, [...sample.entries, entry('E.deep', 'deep', 10000)]))).toBeUndefined();
  });

  it('keeps the recorded manifest within its recorded unit suite time', () => {
    const manifest = readManifest(manifestPath);
    expect(manifest.unitSuiteSeconds).toBeGreaterThan(0);
    expect(tierBudgetProblem(manifest)).toBeUndefined();
    expect(everyRunBudgetSeconds(manifest)).toBeLessThanOrEqual(manifest.unitSuiteSeconds);
  });
});
