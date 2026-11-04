import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVERY_RUN_BUDGET_RATIO, MANIFEST_FORMAT, everyRunBudgetSeconds, readManifest, tierBudgetProblem } from './manifest.ts';
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

const sample = manifestOf(20, [entry('A', 'every-run', 10), entry('A.deep', 'deep', 500), entry('B', 'every-run', 24), entry('C', 'every-run', 46)]);

describe('the time budget of the every-run tier', () => {
  it('allows the every-run tier four times the unit suite time', () => {
    expect(EVERY_RUN_BUDGET_RATIO).toBe(4);
  });

  it('sums the budgets of the every-run entries only', () => {
    expect(everyRunBudgetSeconds(sample)).toBe(80);
  });

  it('accepts a sum equal to the ratio times unitSuiteSeconds', () => {
    expect(tierBudgetProblem(sample)).toBeUndefined();
  });

  it('fails a sum one second over the limit and names the sum, the unit suite seconds, the ratio and the limit', () => {
    const over = manifestOf(20, [...sample.entries, entry('D', 'every-run', 1)]);
    const problem = tierBudgetProblem(over);
    expect(problem).toBeDefined();
    expect(problem).toContain('81 s');
    expect(problem).toContain('over 4 x 20 s = 80 s');
    expect(problem).toContain('20');
    expect(problem).toContain('80');
  });

  it('does not count deep entries against the total', () => {
    expect(tierBudgetProblem(manifestOf(20, [...sample.entries, entry('E.deep', 'deep', 10000)]))).toBeUndefined();
  });

  it('keeps the recorded manifest within the ratio times its recorded unit suite time', () => {
    const manifest = readManifest(manifestPath);
    expect(manifest.unitSuiteSeconds).toBeGreaterThan(0);
    expect(tierBudgetProblem(manifest)).toBeUndefined();
    expect(everyRunBudgetSeconds(manifest)).toBeLessThanOrEqual(4 * manifest.unitSuiteSeconds);
  });
});
