import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { RULE_VERIFY_BUDGET_MS, refusingRefutations } from '@momonga/protocol';
import type { Mandate, PermissionMode, RuleVerdict } from '@momonga/protocol';
import { momongaLayout, systemClock } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { createPolicyFilesystem, operationCatalogueFacts } from '@momonga/tools';
import { mandateRunVerification } from '../../src/process/folder-verification.ts';
import { RULE_VERIFY_LOAD_ALLOWANCE_MS, createRuleVerifier, installedRuleSolver } from '../../src/process/rule-verifier.ts';
import { systemTimers } from '../../src/service/timers.ts';

const SOLVER_GUARD_MS = 60 * 60 * 1000;
const DATASETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../eval/datasets');

type DatasetCase = { id: string; permissionMode?: PermissionMode; mandate?: Mandate };

const mandateCases = (): { file: string; id: string; mode: PermissionMode; mandate: Mandate }[] =>
  fs
    .readdirSync(DATASETS)
    .filter((file) => file.endsWith('.json'))
    .flatMap((file) => {
      const dataset = JSON.parse(fs.readFileSync(path.join(DATASETS, file), 'utf8')) as { cases?: DatasetCase[] };
      return (dataset.cases ?? [])
        .filter((entry) => entry.mandate !== undefined)
        .map((entry) => ({ file, id: entry.id, mode: entry.permissionMode ?? 'manual', mandate: entry.mandate as Mandate }));
    });

const layoutIn = (context: Parameters<typeof withTempDir>[0]) => {
  const root = fs.realpathSync(withTempDir(context));
  const home = `${root}/home`;
  const work = `${root}/work`;
  fs.mkdirSync(`${home}/.ssh`, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  return { home, work };
};

const verificationIn = (layout: { home: string; work: string }) => {
  const stored = new Map<string, RuleVerdict>();
  return mandateRunVerification({
    verifier: createRuleVerifier({
      host: installedRuleSolver(import.meta.url),
      fs: createPolicyFilesystem(),
      paths: momongaLayout(layout.home, process.platform, {}),
      timers: systemTimers,
      bashPath: () => '/bin/bash',
      clock: systemClock,
      budgetMs: RULE_VERIFY_BUDGET_MS,
      startBoundMs: RULE_VERIFY_LOAD_ALLOWANCE_MS,
    }),
    ruleVerdicts: { get: (fingerprint) => (stored.has(fingerprint) ? { verdict: stored.get(fingerprint) as RuleVerdict } : undefined), put: (fingerprint, verdict) => void stored.set(fingerprint, verdict) },
    home: layout.home,
    sessionsRoot: `${layout.home}/.momonga/tmp/sessions`,
    folder: async () => ({ rules: [], additionalDirectories: [], enforcement: 'exact-paths', unixSockets: { kind: 'limited', allowed: [] } }),
    catalogue: operationCatalogueFacts,
    retrySignal: new AbortController().signal,
    onRetryFailure: (error) => {
      throw error;
    },
  });
};

describe('every mandate a shipped eval dataset declares passes the product rule verification', () => {
  vi.setConfig({ testTimeout: SOLVER_GUARD_MS });

  const cases = mandateCases();

  it('finds the mandates of the shipped datasets', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const entry of cases) {
    it(`${entry.file} ${entry.id} is not refuted`, async (context) => {
      const layout = layoutIn(context);
      const verify = verificationIn(layout);

      const verdict = await verify({ cwd: layout.work, mode: entry.mode, mandate: entry.mandate }, new AbortController().signal);

      expect(refusingRefutations(verdict)).toEqual([]);
    });
  }
});
