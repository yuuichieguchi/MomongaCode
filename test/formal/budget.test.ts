import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVERY_RUN_BUDGET_RATIO, MANIFEST_FORMAT, everyRunBudgetSeconds, readManifest, tierBudgetProblem } from './manifest.ts';
import type { Manifest, ManifestEntry } from './manifest.ts';

const manifestPath = path.resolve(import.meta.dirname, '..', '..', 'specs', 'tla', 'manifest.json');

const entry = (config: string, tier: ManifestEntry['tier'], wallSeconds: number): ManifestEntry => ({
  config,
  role: 'check',
  expect: 'holds',
  args: [],
  tier,
  distinctStates: 1,
  measuredSeconds: wallSeconds / 2,
  measuredCpuSeconds: 1,
  budgetCpuSeconds: 5,
});

const manifestOf = (unitSuiteSeconds: number, entries: readonly ManifestEntry[]): Manifest => ({ format: MANIFEST_FORMAT, unitSuiteSeconds, startupCpuSeconds: 3, entries });

const sample = manifestOf(20, [entry('A', 'every-run', 10), entry('A.deep', 'deep', 500), entry('B', 'every-run', 24), entry('C', 'every-run', EVERY_RUN_BUDGET_RATIO * 20 - 34)]);

describe('the time budget of the every-run tier', () => {
  it('allows the every-run tier eleven times the unit suite time', () => {
    expect(EVERY_RUN_BUDGET_RATIO).toBe(13);
  });

  it('sums the budgets of the every-run entries only', () => {
    expect(everyRunBudgetSeconds(sample)).toBe(EVERY_RUN_BUDGET_RATIO * 20);
  });

  it('accepts a sum equal to the ratio times unitSuiteSeconds', () => {
    expect(tierBudgetProblem(sample)).toBeUndefined();
  });

  it('fails a sum one second over the limit and names the sum, the unit suite seconds, the ratio and the limit', () => {
    const over = manifestOf(20, [...sample.entries, entry('D', 'every-run', 1)]);
    const problem = tierBudgetProblem(over);
    expect(problem).toBeDefined();
    const limit = EVERY_RUN_BUDGET_RATIO * 20;
    expect(problem).toContain(`${limit + 1} s`);
    expect(problem).toContain(`over ${EVERY_RUN_BUDGET_RATIO} x 20 s = ${limit} s`);
  });

  it('does not count deep entries against the total', () => {
    expect(tierBudgetProblem(manifestOf(20, [...sample.entries, entry('E.deep', 'deep', 10000)]))).toBeUndefined();
  });

  it('keeps the recorded manifest within the ratio times its recorded unit suite time', () => {
    const manifest = readManifest(manifestPath);
    expect(manifest.unitSuiteSeconds).toBeGreaterThan(0);
    expect(tierBudgetProblem(manifest)).toBeUndefined();
    expect(everyRunBudgetSeconds(manifest)).toBeLessThanOrEqual(EVERY_RUN_BUDGET_RATIO * manifest.unitSuiteSeconds);
  });
});
