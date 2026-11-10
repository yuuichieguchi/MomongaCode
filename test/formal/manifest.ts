import type { Manifest } from './manifest-reader.ts';

export { MANIFEST_FORMAT, discoveryProblems, moduleOf, readManifest } from './manifest-reader.ts';
export type { Expectation, Manifest, ManifestEntry, Role, Tier, TlcRun, TlcRunOptions, Violation } from './manifest-reader.ts';
export { TLC_WORKERS, runTlc } from './runner.ts';
export { verdictProblems } from './verdict.ts';

export const everyRunBudgetSeconds = (manifest: Manifest): number =>
  manifest.entries.filter((entry) => entry.tier === 'every-run').reduce((total, entry) => total + Math.ceil(2 * entry.measuredSeconds), 0);

export const EVERY_RUN_BUDGET_RATIO = 24;

export const tierBudgetProblem = (manifest: Manifest): string | undefined => {
  const total = everyRunBudgetSeconds(manifest);
  const limit = EVERY_RUN_BUDGET_RATIO * manifest.unitSuiteSeconds;
  return total > limit ? `the every-run budgets sum to ${total} s, over ${EVERY_RUN_BUDGET_RATIO} x ${manifest.unitSuiteSeconds} s = ${limit} s` : undefined;
};
