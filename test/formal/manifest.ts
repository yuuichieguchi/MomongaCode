import path from 'node:path';
import { readManifest } from './manifest-reader.ts';
import type { Manifest } from './manifest-reader.ts';

const MANIFEST_FILE = path.resolve(import.meta.dirname, '..', '..', 'specs', 'tla', 'manifest.json');

export const moduleHeaderOf = (module: string): string => {
  const entry = readManifest(MANIFEST_FILE).modules.find((candidate) => candidate.module === module);
  if (entry?.header === undefined) throw new Error(`the manifest holds no header for the module ${module}`);
  return entry.header.join('\n');
};

export { MANIFEST_FORMAT, discoveryProblems, moduleOf, readManifest } from './manifest-reader.ts';
export type { Expectation, Manifest, ManifestEntry, ModuleLimits, Role, Tier, TlcRun, TlcRunOptions, Violation } from './manifest-reader.ts';
export { TLC_WORKERS, notProvedText, runTlc } from './runner.ts';
export { verdictProblems } from './verdict.ts';

export const everyRunColdSeconds = (manifest: Manifest): number =>
  Number(manifest.entries.filter((entry) => entry.tier === 'every-run').reduce((total, entry) => total + entry.measuredSeconds, 0).toFixed(2));

export const tierBudgetProblem = (manifest: Manifest): string | undefined => {
  const total = everyRunColdSeconds(manifest);
  return total > manifest.unitSuiteSeconds ? `the every-run rows take ${total} s cold, over the unit suite wall time of ${manifest.unitSuiteSeconds} s` : undefined;
};
