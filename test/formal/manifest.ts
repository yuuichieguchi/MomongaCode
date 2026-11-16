import type { Manifest } from './manifest-reader.ts';

export { MANIFEST_FORMAT, discoveryProblems, moduleOf, readManifest } from './manifest-reader.ts';
export type { Expectation, Manifest, ManifestEntry, Role, Tier, TlcRun, TlcRunOptions, Violation } from './manifest-reader.ts';
export { TLC_WORKERS, runTlc } from './runner.ts';
export { verdictProblems } from './verdict.ts';

export const everyRunColdSeconds = (manifest: Manifest): number =>
  Number(manifest.entries.filter((entry) => entry.tier === 'every-run').reduce((total, entry) => total + entry.measuredSeconds, 0).toFixed(2));

export const tierBudgetProblem = (manifest: Manifest): string | undefined => {
  const total = everyRunColdSeconds(manifest);
  return total > manifest.unitSuiteSeconds ? `the every-run rows take ${total} s cold, over the unit suite wall time of ${manifest.unitSuiteSeconds} s` : undefined;
};
