import { describe, expect, it } from 'vitest';
import { hostPhasesOf, runRuleVerifyJob } from '../../src/process/rule-verifier-thread.ts';
import type { RuleVerifyJob } from '../../src/process/rule-verifier-thread.ts';

const job: RuleVerifyJob = {
  input: { rules: [], roots: ['/work'], mode: 'manual', home: '/home/u', deniedLocations: [], cwd: '/work', exemptDirectory: null, enforcement: 'exact-paths', protectedSet: {} as never, secretLocations: [] },
  solver: { kind: 'installed', entry: '/nowhere/z3.js' },
  solverVersion: 'z3 1',
  budgetMs: 60_000,
  askedAtMs: 1_000,
  platform: 'linux',
  bashPath: '/bin/bash',
};

describe('a verification job inside its thread', () => {
  it('runs under the signal of its asker: an asker that is gone ends the job with its reason before the solver is opened', async () => {
    const asker = new AbortController();
    asker.abort(new Error('the run was cancelled'));
    await expect(runRuleVerifyJob(job, { signal: asker.signal, clock: { now: () => 1_000 } })).rejects.toThrow('the run was cancelled');
  });

  it('opens the solver for an asker that is present, and fails with the cause when the solver cannot be loaded', async () => {
    await expect(runRuleVerifyJob(job, { signal: new AbortController().signal, clock: { now: () => 1_000 } })).rejects.toThrow(/\/nowhere\/z3\.js/);
  });

  it('times the start of the thread from the moment the runtime asked, then the load of the solver and its instantiation', () => {
    expect(hostPhasesOf({ askedAtMs: 1_000, enteredAtMs: 1_135, loadedAtMs: 1_231, instantiatedAtMs: 1_308 })).toEqual([
      { phase: 'thread-start', ms: 135 },
      { phase: 'load', ms: 96 },
      { phase: 'instantiate', ms: 77 },
    ]);
  });
});
