import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { stateDirOf } from '../../scripts/support/dev-state.ts';
import { checkEntry, createTierReport } from './check-entry.ts';
import type { ManifestEntry, ModuleLimits, Tier } from './manifest-reader.ts';
import { moduleOf } from './manifest-reader.ts';
import { createManifestRowWriter, recordedRowOf, recordsTier } from './record.ts';
import { createJavaIdentityReader, createResultStore, reuseModeOf } from './reuse.ts';
import type { JavaIdentity, ResultStore } from './reuse.ts';
import { TLC_WORKERS, notProvedText } from './runner.ts';

export type TierOptions = {
  tier: Tier;
  entries: readonly ManifestEntry[] | Error;
  modules: readonly ModuleLimits[];
  manifestConfigs: readonly string[];
  script: string;
  repoRoot: string;
  env: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
  stateDir?: string;
  startupCpuSeconds: number;
};

const RESULTS_DIR = 'tlc-results';

const storeOutsideReuseMode = (): never => {
  throw new Error('the result store belongs to a reuse-mode run');
};

const noStore: ResultStore = { read: storeOutsideReuseMode, write: storeOutsideReuseMode, removeOrphans: storeOutsideReuseMode };

type TierSession = {
  readonly mode: 'on' | 'off';
  readonly store: ResultStore;
  readonly reuses: boolean;
  readonly java: (limitMs: number) => Promise<JavaIdentity | undefined>;
  readonly record: boolean;
};

const titleOf = (entry: ManifestEntry): string => `${entry.config} ${entry.expect === 'holds' ? 'holds' : `violates ${entry.expect.violates}`}`;

export const describeTier = (options: TierOptions): void => {
  const { tier, manifestConfigs, script, repoRoot, env } = options;
  const loadError = options.entries instanceof Error ? options.entries : undefined;
  const entries = options.entries instanceof Error ? [] : options.entries;
  const now = options.now ?? ((): Date => new Date());

  const suite = tier === 'deep' ? describe.concurrent : describe;

  suite(`TLC over every ${tier} configuration in the manifest`, () => {
    const report = createTierReport(tier);
    const writeRow = createManifestRowWriter(path.join(repoRoot, 'specs', 'tla', 'manifest.json'));
    let opened: TierSession | undefined;

    const openSession = (): TierSession => {
      const mode = reuseModeOf(env);
      const reuses = mode === 'on';
      return {
        mode,
        reuses,
        store: reuses ? createResultStore(path.join(options.stateDir ?? stateDirOf(repoRoot, env), RESULTS_DIR)) : noStore,
        java: createJavaIdentityReader({ env }),
        record: recordsTier(tier, env),
      };
    };

    const session = (): TierSession => {
      opened ??= openSession();
      return opened;
    };

    afterAll(async () => {
      report.print();
      if (loadError !== undefined || opened?.reuses !== true) return;
      const cleanup = await opened.store.removeOrphans(manifestConfigs);
      if (cleanup.reason !== undefined) process.stderr.write(`store cleanup: ${cleanup.reason}\n`);
    });

    it('has configurations in this tier', () => {
      if (loadError !== undefined) throw loadError;
      session();
      expect(entries.length).toBeGreaterThan(0);
    });

    for (const entry of entries) {
      const limitMs = entry.budgetCpuSeconds * TLC_WORKERS * 1000;
      it(
        titleOf(entry),
        async () => {
          const { mode, store, java, record } = session();
          const outcome = await checkEntry({ entry, script, repoRoot, mode, env, store, java, limitMs, now, record, loadAverage: () => os.loadavg()[0] as number });
          report.add(entry.config, outcome);
          if (outcome.outcome === 'ran' && outcome.measurement !== undefined && outcome.loadAtStart !== undefined) {
            await writeRow(await recordedRowOf(repoRoot, entry, outcome.measurement, options.startupCpuSeconds, outcome.loadAtStart));
            process.stderr.write(`record mode: ${entry.config} written to specs/tla/manifest.json\n`);
          }
          const limits = options.modules.find((module) => module.module === moduleOf(entry.config));
          if (limits === undefined) throw new Error(`${entry.config}: the manifest has no modules entry for ${moduleOf(entry.config)}`);
          process.stderr.write(notProvedText(entry.config, limits));
          expect(outcome.outcome === 'ran' ? outcome.problems : []).toEqual([]);
        },
        limitMs,
      );
    }
  });
};
