import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { RULE_VERIFY_BUDGET_MS, isFinalRuleVerdict, refusingRefutations } from '@momonga/protocol';
import type { RuleVerdict } from '@momonga/protocol';
import { momongaLayout, systemClock } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { createPolicyFilesystem, operationCatalogueFacts } from '@momonga/tools';
import { mandateRunVerification } from '../../src/process/folder-verification.ts';
import { RULE_VERIFY_LOAD_ALLOWANCE_MS, createRuleVerifier, installedRuleSolver } from '../../src/process/rule-verifier.ts';
import { systemTimers } from '../../src/service/timers.ts';

const SOLVER_GUARD_MS = 60 * 60 * 1000;
const SMALL_BUDGET_MS = 1;

const layoutIn = (context: Parameters<typeof withTempDir>[0]) => {
  const root = fs.realpathSync(withTempDir(context));
  const home = `${root}/home`;
  const work = `${root}/work`;
  fs.mkdirSync(`${home}/.ssh`, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  return { home, work };
};

const verificationIn = (layout: { home: string; work: string }, budgetMs: number, stored: Map<string, RuleVerdict>) =>
  mandateRunVerification({
    verifier: createRuleVerifier({
      host: installedRuleSolver(import.meta.url),
      fs: createPolicyFilesystem(),
      paths: momongaLayout(layout.home, process.platform, {}),
      timers: systemTimers,
      bashPath: () => '/bin/bash',
      clock: systemClock,
      budgetMs,
      startBoundMs: RULE_VERIFY_LOAD_ALLOWANCE_MS,
    }),
    ruleVerdicts: { get: (fingerprint) => (stored.has(fingerprint) ? { verdict: stored.get(fingerprint) as RuleVerdict } : undefined), put: (fingerprint, verdict) => void stored.set(fingerprint, verdict) },
    home: layout.home,
    sessionsRoot: `${layout.home}/.momonga/tmp/sessions`,
    folder: async () => ({ rules: [], additionalDirectories: [], enforcement: 'exact-paths', unixSockets: { kind: 'limited', allowed: [] } }),
    catalogue: operationCatalogueFacts,
  });

describe('the mandate of a run is verified with its two properties and its own rules', () => {
  vi.setConfig({ testTimeout: SOLVER_GUARD_MS });

  it('refutes a mandate whose allow rule admits a form that an operation replaces', async (context) => {
    const layout = layoutIn(context);
    const verify = verificationIn(layout, RULE_VERIFY_BUDGET_MS, new Map());

    const verdict = await verify({ cwd: layout.work, mode: 'manual', mandate: { scope: { allow: ['Bash(git push:*)'], ask: [], deny: [] } } }, new AbortController().signal);

    expect(refusingRefutations(verdict).map((refutation) => refutation.property)).toContain('superseded-forms');
  });

  it('proves a mandate whose rules admit no superseded form and no operation that is always held, and keeps the final verdict', async (context) => {
    const layout = layoutIn(context);
    const stored = new Map<string, RuleVerdict>();
    const verify = verificationIn(layout, RULE_VERIFY_BUDGET_MS, stored);

    const verdict = await verify({ cwd: layout.work, mode: 'manual', mandate: { scope: { allow: ['Read(src/**)'], ask: [], deny: [] } } }, new AbortController().signal);

    expect(refusingRefutations(verdict)).toEqual([]);
    expect([...stored.values()]).toEqual(isFinalRuleVerdict(verdict) ? [verdict] : []);
  });

  it('never refuses and keeps nothing that is not final when the solver has a small budget', async (context) => {
    const layout = layoutIn(context);
    const stored = new Map<string, RuleVerdict>();
    const verify = verificationIn(layout, SMALL_BUDGET_MS, stored);

    const verdict = await verify({ cwd: layout.work, mode: 'manual', mandate: { scope: { allow: ['Read(src/**)'], ask: [], deny: [] } } }, new AbortController().signal);

    expect(refusingRefutations(verdict)).toEqual([]);
    expect([...stored.values()]).toEqual(isFinalRuleVerdict(verdict) ? [verdict] : []);
  });
});
