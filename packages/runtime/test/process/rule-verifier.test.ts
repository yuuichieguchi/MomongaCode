import type { UnixSocketPolicy } from '@momonga/foundation';
import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PERMISSION_MODES, RULE_VERIFY_BUDGET_MS } from '@momonga/protocol';
import { createFakeClock, createFakeTimers, withTempDir, NEVER_CANCELLED } from '@momonga/testkit';
import { createPolicyFilesystem } from '@momonga/tools';
import { parseRule } from '@momonga/config';
import { RULE_VERIFY_LOAD_ALLOWANCE_MS, createRuleVerifier, installedRuleSolver } from '../../src/process/rule-verifier.ts';
import { RuleVerificationFailure } from '../../src/process/rule-verifier-thread-client.ts';
import type { RuleSolverHost } from '../../src/process/rule-verifier.ts';
import { systemTimers } from '../../src/service/timers.ts';
import { policyRefusal } from '../../src/worker/rule-verdict.ts';
import { BUDGET_THREAD_CODE, FAKE_SOLVER_VERSION, REPORTING_THREAD_CODE, provedRuleSolver, provedVerifier } from './fake-rule-solver.ts';

const SOLVER_GUARD_MS = 60 * 60 * 1000;

const request = { rules: [], roots: ['/work'], mode: 'manual', home: '/home/u', cwd: '/work', exemptDirectory: '/home/u/.momonga/tmp/sessions/s1', enforcement: 'exact-paths', secrets: [], unixSockets: { kind: 'limited', allowed: [] } } as const;
const paths = { home: '/home/u', root: '/home/u/.momonga', keychains: '/home/u/keys' } as never;

describe('the rule verifier of the runtime process', () => {
  it('prepares an input with the protected set and the secret locations, and starts no thread for it', async () => {
    const host: RuleSolverHost = {
      ...provedRuleSolver(),
      loadVerifier: async () => ({ ...provedVerifier, secretLocationsOf: (layout: { home: string }) => [{ label: 'ssh', directory: `${layout.home}/.ssh` }] }) as never,
      threadCode: `throw new Error('no thread is expected')`,
    };
    const verifier = createRuleVerifier({ host, fs: createPolicyFilesystem(), paths, timers: systemTimers, bashPath: () => '/bin/bash', clock: createFakeClock(0), budgetMs: RULE_VERIFY_BUDGET_MS, startBoundMs: RULE_VERIFY_LOAD_ALLOWANCE_MS });
    const { secrets, unixSockets, ...subject } = request;
    expect(unixSockets).toEqual({ kind: 'limited', allowed: [] });
    expect(secrets).toEqual([]);
    expect(await verifier.inputOf(request, NEVER_CANCELLED)).toEqual({ ...subject, unixSockets, secretLocations: [{ label: 'ssh', directory: '/home/u/.ssh' }], deniedLocations: [{ label: 'ssh', directory: '/home/u/.ssh' }], protectedSet: expect.any(Object) });
  });

  it('verifies in a thread that runs the code of its host, with the version of the solver, under one timer that bounds only the start of the thread', async () => {
    const timers = createFakeTimers(createFakeClock(0));
    const waits: number[] = [];
    const verifier = createRuleVerifier({
      host: provedRuleSolver(),
      fs: createPolicyFilesystem(),
      paths,
      timers: { setTimeout: (callback, ms) => (waits.push(ms), timers.setTimeout(callback, ms)), clearTimeout: timers.clearTimeout, monotonicMs: timers.monotonicMs },
      bashPath: () => '/bin/bash',
      clock: createFakeClock(0),
      budgetMs: RULE_VERIFY_BUDGET_MS,
      startBoundMs: RULE_VERIFY_LOAD_ALLOWANCE_MS,
    });
    expect(await verifier.verify(await verifier.inputOf(request, NEVER_CANCELLED), new AbortController().signal)).toEqual({ verdict: 'proved', solver: FAKE_SOLVER_VERSION, refuted: [], unknown: [], notProved: [] });
    expect(RULE_VERIFY_LOAD_ALLOWANCE_MS).toBeGreaterThan(0);
    expect(waits).toEqual([RULE_VERIFY_LOAD_ALLOWANCE_MS]);
  });

  it('fails with an error, not a verdict, when its thread fails', async () => {
    const host: RuleSolverHost = { ...provedRuleSolver(), threadCode: `throw new Error('the solver is broken')` };
    const verifier = createRuleVerifier({ host, fs: createPolicyFilesystem(), paths, timers: systemTimers, bashPath: () => '/bin/bash', clock: createFakeClock(0), budgetMs: RULE_VERIFY_BUDGET_MS, startBoundMs: RULE_VERIFY_LOAD_ALLOWANCE_MS });
    const input = await verifier.inputOf(request, NEVER_CANCELLED);
    await expect(verifier.verify(input, new AbortController().signal)).rejects.toBeInstanceOf(RuleVerificationFailure);
    await expect(verifier.report(input, new AbortController().signal)).rejects.toThrow('the verification thread failed: the solver is broken');
  });

  it('gives the thread the budget it was built with, and the secret locations the request names beside those of the layout', async () => {
    const host: RuleSolverHost = {
      ...provedRuleSolver(),
      loadVerifier: async () => ({ ...provedVerifier, secretLocationsOf: (_layout: unknown, extra: readonly string[]) => extra.map((directory) => ({ label: 'named', directory })) }) as never,
      threadCode: BUDGET_THREAD_CODE,
    };
    const verifier = createRuleVerifier({ host, fs: createPolicyFilesystem(), paths, timers: systemTimers, bashPath: () => '/bin/bash', clock: createFakeClock(0), budgetMs: 4321, startBoundMs: RULE_VERIFY_LOAD_ALLOWANCE_MS });
    const input = await verifier.inputOf({ ...request, secrets: ['/home/u/vault'] }, NEVER_CANCELLED);
    expect(input).toMatchObject({ secretLocations: [{ directory: '/home/u/vault' }] });
    expect((await verifier.report(input, new AbortController().signal)).report).toBe('budget 4321');
  });

  it('carries the checks of a mandate in the input it prepares, so that they are verified and are part of its key', async () => {
    const verifier = createRuleVerifier({ host: provedRuleSolver(), fs: createPolicyFilesystem(), paths, timers: systemTimers, bashPath: () => '/bin/bash', clock: createFakeClock(0), budgetMs: RULE_VERIFY_BUDGET_MS, startBoundMs: RULE_VERIFY_LOAD_ALLOWANCE_MS });
    const mandateChecks = { supersededForms: [], alwaysOperations: ['git.push'] };
    expect(await verifier.inputOf({ ...request, mandateChecks }, NEVER_CANCELLED)).toMatchObject(mandateChecks);
  });

  it('says whether a prepared input needs a verdict at all, by the one predicate of the verifier', async () => {
    const verifier = createRuleVerifier({ host: installedRuleSolver(import.meta.url), fs: createPolicyFilesystem(), paths, timers: systemTimers, bashPath: () => '/bin/bash', clock: createFakeClock(0), budgetMs: RULE_VERIFY_BUDGET_MS, startBoundMs: RULE_VERIFY_LOAD_ALLOWANCE_MS });
    const rule = (text: string, effect: 'allow' | 'deny') => parseRule(text, { effect, origin: 'user', source: '/home/u/.momonga/settings.json', settingsRoot: '/home/u', home: '/home/u', cwd: '/work' } as never);
    expect(await verifier.needsVerdict(await verifier.inputOf({ ...request, rules: [rule('Read(.env)', 'deny')] }, NEVER_CANCELLED))).toBe(false);
    expect(await verifier.needsVerdict(await verifier.inputOf({ ...request, rules: [rule('Read(src/**)', 'allow')] }, NEVER_CANCELLED))).toBe(true);
  });

  it('refuses an input it did not prepare', async () => {
    const verifier = createRuleVerifier({ host: provedRuleSolver(), fs: createPolicyFilesystem(), paths, timers: systemTimers, bashPath: () => '/bin/bash', clock: createFakeClock(0), budgetMs: RULE_VERIFY_BUDGET_MS, startBoundMs: RULE_VERIFY_LOAD_ALLOWANCE_MS });
    await expect(verifier.verify({ ...request, protectedSet: {}, secretLocations: [], deniedLocations: [] }, new AbortController().signal)).rejects.toThrow('the rule verifier was given an input it did not prepare');
  });

  it('names the installed solver by the sha256 of its code, the form the bundled solver has, and reads the code once', async () => {
    const solver = installedRuleSolver(import.meta.url);
    const identity = await solver.solverVersion();
    expect(identity).toMatch(/^z3 [0-9a-f]{64}$/);
    expect(solver.solverVersion()).toBe(solver.solverVersion());
    expect(await installedRuleSolver(import.meta.url).solverVersion()).toBe(identity);
  });

  it('gives the report of the thread with its verdict, for the command that prints it', async () => {
    const host: RuleSolverHost = { ...provedRuleSolver(), threadCode: REPORTING_THREAD_CODE };
    const verifier = createRuleVerifier({ host, fs: createPolicyFilesystem(), paths, timers: systemTimers, bashPath: () => '/bin/bash', clock: createFakeClock(0), budgetMs: RULE_VERIFY_BUDGET_MS, startBoundMs: RULE_VERIFY_LOAD_ALLOWANCE_MS });
    expect(await verifier.report(await verifier.inputOf(request, NEVER_CANCELLED), new AbortController().signal)).toEqual({
      verdict: { verdict: 'proved', solver: FAKE_SOLVER_VERSION, refuted: [], unknown: [], notProved: [] },
      report: 'policy verification of 0 rule(s)',
      findings: { exitCode: 0 },
    });
  });

});

describe('the rule verifier with the installed solver, in the thread of the product', () => {
  vi.setConfig({ testTimeout: SOLVER_GUARD_MS });

  const verifierIn = (root: string) => createRuleVerifier({ host: installedRuleSolver(import.meta.url), fs: createPolicyFilesystem(), paths: { home: `${root}/home`, root: `${root}/home/.momonga`, keychains: `${root}/home/keys` } as never, timers: systemTimers, bashPath: () => '/bin/bash', clock: createFakeClock(0), budgetMs: RULE_VERIFY_BUDGET_MS, startBoundMs: RULE_VERIFY_LOAD_ALLOWANCE_MS });
  const ruleIn = (root: string, text: string, effect: 'allow' | 'deny') => parseRule(text, { effect, origin: 'user', source: `${root}/home/.momonga/settings.json`, settingsRoot: `${root}/home`, home: `${root}/home`, cwd: `${root}/work` } as never);

  it('proves a rule set without a hole, an allow narrowed by a deny included, and refutes an allow that opens a secret location', async (context) => {
    const root = fs.realpathSync(withTempDir(context));
    fs.mkdirSync(`${root}/work`);
    fs.mkdirSync(`${root}/home`);
    const facts = { roots: [`${root}/work`], mode: 'manual', home: `${root}/home`, cwd: `${root}/work`, exemptDirectory: `${root}/home/.momonga/tmp/sessions/s1`, enforcement: 'exact-paths', secrets: [], unixSockets: { kind: 'limited', allowed: [] } } as const;
    const verifier = verifierIn(root);
    const proved = await verifier.verify(await verifier.inputOf({ ...facts, rules: [ruleIn(root, 'Read(//etc/**)', 'deny')] }, NEVER_CANCELLED), new AbortController().signal);
    expect(proved).toMatchObject({ verdict: 'proved', solver: expect.stringMatching(/^z3 [0-9a-f]{64}$/), refuted: [], unknown: [] });
    expect(proved.notProved.length).toBeGreaterThan(0);
    expect(proved.phases?.map((entry) => entry.phase)).toEqual(['thread-start', 'load', 'instantiate', 'deny-precedence', 'secret-reach', 'rule-consistency', 'bash-admission']);
    const narrowed = await verifier.verify(await verifier.inputOf({ ...facts, rules: [ruleIn(root, 'Bash', 'allow'), ruleIn(root, 'Bash(git push:*)', 'deny')] }, NEVER_CANCELLED), new AbortController().signal);
    expect(narrowed).toMatchObject({ verdict: 'proved', refuted: [], unknown: [] });
    const refuted = await verifier.verify(await verifier.inputOf({ ...facts, rules: [ruleIn(root, 'Read(~/**)', 'allow')] }, NEVER_CANCELLED), new AbortController().signal);
    expect(refuted).toMatchObject({ verdict: 'refuted', refuted: expect.arrayContaining([expect.objectContaining({ property: 'secret-reach' })]) });
  });

  const homeIn = (context: Parameters<typeof withTempDir>[0]): { root: string; facts: { roots: string[]; home: string; cwd: string; exemptDirectory: string; enforcement: 'exact-paths'; secrets: string[]; unixSockets: UnixSocketPolicy } } => {
    const root = fs.realpathSync(withTempDir(context));
    fs.mkdirSync(`${root}/work`);
    fs.mkdirSync(`${root}/home/.ssh`, { recursive: true });
    return { root, facts: { roots: [`${root}/work`], home: `${root}/home`, cwd: `${root}/work`, exemptDirectory: `${root}/home/.momonga/tmp/sessions/s1`, enforcement: 'exact-paths', secrets: [], unixSockets: { kind: 'limited', allowed: [] } } };
  };

  it.for(PERMISSION_MODES)('refuses no run in the %s mode when no rule is written: no mode default opens a secret location', async (mode, context) => {
    const { root, facts } = homeIn(context);
    const verifier = verifierIn(root);
    const verdict = await verifier.verify(await verifier.inputOf({ ...facts, mode, rules: [] }, NEVER_CANCELLED), new AbortController().signal);
    expect(verdict.refuted).toEqual([]);
    expect(verdict.verdict).not.toBe('refuted');
    expect(policyRefusal({ fingerprint: 'f'.repeat(64), ...verdict })).toBeUndefined();
    expect(verdict).not.toHaveProperty('byModeDefault');
  });

  it.for(PERMISSION_MODES)('refuses the run in the %s mode when one rule opens a secret location, naming the rule', async (mode, context) => {
    const { root, facts } = homeIn(context);
    const verifier = verifierIn(root);
    const verdict = await verifier.verify(await verifier.inputOf({ ...facts, mode, rules: [ruleIn(root, 'Read(~/**)', 'allow')] }, NEVER_CANCELLED), new AbortController().signal);
    expect(verdict.verdict).toBe('refuted');
    expect(verdict.refuted).toEqual(expect.arrayContaining([expect.objectContaining({ property: 'secret-reach', message: expect.stringContaining('Read(~/**)') })]));
    expect(policyRefusal({ fingerprint: 'f'.repeat(64), ...verdict })).toMatchObject({ code: 'policy_refuted' });
  });
});
