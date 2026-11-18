import path from 'node:path';
import { reusableOf } from './check-entry.ts';
import type { ManifestEntry, Tier } from './manifest-reader.ts';
import { readManifest } from './manifest-reader.ts';
import { recordsTier } from './record.ts';
import { createJavaIdentityReader, createResultStore } from './reuse.ts';
import { TLC_WORKERS } from './runner.ts';

export type ColdRunPlan = { readonly budgetCpuSeconds: number; readonly cold: readonly string[] };

export const coldRunPlanOf = async ({ entries, isReusable }: { entries: readonly ManifestEntry[]; isReusable: (entry: ManifestEntry) => Promise<boolean> }): Promise<ColdRunPlan> => {
  const cold: ManifestEntry[] = [];
  for (const entry of entries) if (!(await isReusable(entry))) cold.push(entry);
  for (const entry of cold) {
    if (typeof entry.budgetCpuSeconds !== 'number') throw new Error(`run-lock: no CPU budget for ${entry.config}: its row in specs/tla/manifest.json has no budgetCpuSeconds`);
  }
  return { budgetCpuSeconds: cold.reduce((total, entry) => total + entry.budgetCpuSeconds, 0), cold: cold.map((entry) => entry.config) };
};

export type TierRunOptions = {
  readonly tier: Tier;
  readonly manifestPath: string;
  readonly repoRoot: string;
  readonly stateDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly reuse: boolean;
};

export const tierRunPlanOf = async (options: TierRunOptions): Promise<ColdRunPlan> => {
  const entries = readManifest(options.manifestPath).entries.filter((entry) => entry.tier === options.tier);
  const store = options.reuse ? createResultStore(path.join(options.stateDir, 'tlc-results')) : undefined;
  const java = createJavaIdentityReader({ env: options.env });
  return coldRunPlanOf({
    entries,
    isReusable: async (entry) =>
      store !== undefined && (await reusableOf({ entry, repoRoot: options.repoRoot, mode: 'on', env: options.env, store, java, limitMs: entry.budgetCpuSeconds * TLC_WORKERS * 1000, record: recordsTier(options.tier, options.env) })),
  });
};
