import { describe, expect, it } from 'vitest';
import { runRuleVerifyJob } from '../../src/process/rule-verifier-thread.ts';
import type { RuleVerifyJob } from '../../src/process/rule-verifier-thread.ts';

const job: RuleVerifyJob = {
  input: { rules: [], roots: ['/work'], mode: 'manual', home: '/home/u', cwd: '/work', exemptDirectory: null, enforcement: 'exact-paths', protectedSet: {} as never, secretLocations: [] },
  solver: { kind: 'installed', entry: '/nowhere/z3.js' },
  solverVersion: 'z3 1',
  budgetMs: 60_000,
};

describe('a verification job inside its thread', () => {
  it('runs under the signal of its asker: an asker that is gone ends the job with its reason before the solver is opened', async () => {
    const asker = new AbortController();
    asker.abort(new Error('the run was cancelled'));
    await expect(runRuleVerifyJob(job, asker.signal)).rejects.toThrow('the run was cancelled');
  });

  it('opens the solver for an asker that is present, and fails with the cause when the solver cannot be loaded', async () => {
    await expect(runRuleVerifyJob(job, new AbortController().signal)).rejects.toThrow(/\/nowhere\/z3\.js/);
  });
});
