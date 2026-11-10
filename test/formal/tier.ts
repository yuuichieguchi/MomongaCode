import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { stateDirOf } from '../../scripts/support/dev-state.ts';
import { checkEntry, createTierReport } from './check-entry.ts';
import type { ManifestEntry, Tier } from './manifest-reader.ts';
import { createJavaIdentityReader, createResultStore, reuseModeOf } from './reuse.ts';
import type { JavaIdentity, ResultStore } from './reuse.ts';
import { TLC_WORKERS } from './runner.ts';

export type TierOptions = {
  tier: Tier;
  entries: readonly ManifestEntry[];
  manifestConfigs: readonly string[];
  script: string;
  repoRoot: string;
  env: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
  stateDir?: string;
};

const RESULTS_DIR = 'tlc-results';

const storeOutsideReuseMode = (): never => {
  throw new Error('the result store belongs to a reuse-mode run of the every-run tier');
};

const noStore: ResultStore = { read: storeOutsideReuseMode, write: storeOutsideReuseMode, removeOrphans: storeOutsideReuseMode };

type TierSession = {
  readonly mode: 'on' | 'off';
  readonly store: ResultStore;
  readonly reuses: boolean;
  readonly java: (limitMs: number) => Promise<JavaIdentity | undefined>;
};

const titleOf = (entry: ManifestEntry): string => `${entry.config} ${entry.expect === 'holds' ? 'holds' : `violates ${entry.expect.violates}`}`;

export const describeTier = (options: TierOptions): void => {
  const { tier, entries, manifestConfigs, script, repoRoot, env } = options;
  const now = options.now ?? ((): Date => new Date());

  describe(`TLC over every ${tier} configuration in the manifest`, () => {
    const report = createTierReport(tier);
    let opened: TierSession | undefined;

    const openSession = (): TierSession => {
      const mode = reuseModeOf(env);
      const reuses = mode === 'on' && tier === 'every-run';
      return {
        mode,
        reuses,
        store: reuses ? createResultStore(path.join(options.stateDir ?? stateDirOf(repoRoot, env), RESULTS_DIR)) : noStore,
        java: createJavaIdentityReader({ env }),
      };
    };

    const session = (): TierSession => {
      opened ??= openSession();
      return opened;
    };

    afterAll(async () => {
      report.print();
      if (opened?.reuses !== true) return;
      const cleanup = await opened.store.removeOrphans(manifestConfigs);
      if (cleanup.reason !== undefined) process.stderr.write(`store cleanup: ${cleanup.reason}\n`);
    });

    it('has configurations in this tier', () => {
      session();
      expect(entries.length).toBeGreaterThan(0);
    });

    for (const entry of entries) {
      const limitMs = entry.budgetCpuSeconds * TLC_WORKERS * 1000;
      it(
        titleOf(entry),
        async () => {
          const { mode, store, java } = session();
          const outcome = await checkEntry({ entry, script, repoRoot, tier, mode, env, store, java, limitMs, now });
          report.add(entry.config, outcome);
          expect(outcome.outcome === 'ran' ? outcome.problems : []).toEqual([]);
        },
        limitMs,
      );
    }
  });
};
