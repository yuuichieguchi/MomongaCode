import type { UnixSocketPolicy } from '@momonga/foundation';
import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PERMISSION_MODES, RULE_VERIFY_BUDGET_MS } from '@momonga/protocol';
import { createFakeClock, createFakeTimers, withTempDir, NEVER_CANCELLED } from '@momonga/testkit';
import { createPolicyFilesystem } from '@momonga/tools';
import { parseRule } from '@momonga/config';
import { RULE_VERIFY_LOAD_ALLOWANCE_MS, createRuleVerifier, installedRuleSolver } from '../../src/process/rule-verifier.ts';
import type { RuleSolverHost } from '../../src/process/rule-verifier.ts';
import { systemTimers } from '../../src/service/timers.ts';
import { policyRefusal } from '../../src/worker/rule-verdict.ts';
import { FAKE_SOLVER_VERSION, REPORTING_THREAD_CODE, provedRuleSolver, provedVerifier } from './fake-rule-solver.ts';

const SOLVER_GUARD_MS = 60 * 60 * 1000;

const request = { rules: [], roots: ['/work'], mode: 'manual', home: '/home/u', cwd: '/work', exemptDirectory: '/home/u/.momonga/tmp/sessions/s1', enforcement: 'exact-paths', unixSockets: { kind: 'limited', allowed: [] } } as const;
const paths = { home: '/home/u', root: '/home/u/.momonga', keychains: '/home/u/keys' } as never;

describe('the rule verifier of the runtime process', () => {
  it('prepares an input with the protected set and the secret locations, and starts no thread for it', async () => {
    const host: RuleSolverHost = {
      ...provedRuleSolver({ executables: '/x' }),
      loadVerifier: async () => ({ ...provedVerifier, secretLocationsOf: (layout: { home: string }) => [{ label: 'ssh', directory: `${layout.home}/.ssh` }] }) as never,
      threadCode: `throw new Error('no thread is expected')`,
    };
    const verifier = createRuleVerifier({ host, fs: createPolicyFilesystem(), paths, timers: systemTimers, bashPath: () => '/bin/bash', clock: createFakeClock(0) });
    expect(await verifier.inputOf(request, NEVER_CANCELLED)).toMatchObject({ ...request, secretLocations: [{ directory: '/home/u/.ssh' }], protectedSet: expect.any(Object) });
  });

  it('verifies in a thread that runs the code of its host, with the version of the solver, under one thread timer that is the budget of the design and the load allowance', async () => {
    const timers = createFakeTimers(createFakeClock(0));
    const waits: number[] = [];
    const verifier = createRuleVerifier({
      host: provedRuleSolver({ executables: '/x' }),
      fs: createPolicyFilesystem(),
      paths,
      timers: { setTimeout: (callback, ms) => (waits.push(ms), timers.setTimeout(callback, ms)), clearTimeout: timers.clearTimeout },
      bashPath: () => '/bin/bash',
      clock: createFakeClock(0),
    });
    expect(await verifier.verify(await verifier.inputOf(request, NEVER_CANCELLED), new AbortController().signal)).toEqual({ verdict: 'proved', solver: FAKE_SOLVER_VERSION, refuted: [], unknown: [], notProved: [] });
    expect(RULE_VERIFY_LOAD_ALLOWANCE_MS).toBeGreaterThan(0);
    expect(waits).toEqual([RULE_VERIFY_BUDGET_MS + RULE_VERIFY_LOAD_ALLOWANCE_MS]);
  });

  it('gives verdict unknown with the reason when its thread fails', async () => {
    const host: RuleSolverHost = { ...provedRuleSolver({ executables: '/x' }), threadCode: `throw new Error('the solver is broken')` };
    const verifier = createRuleVerifier({ host, fs: createPolicyFilesystem(), paths, timers: systemTimers, bashPath: () => '/bin/bash', clock: createFakeClock(0) });
    expect(await verifier.verify(await verifier.inputOf(request, NEVER_CANCELLED), new AbortController().signal)).toMatchObject({
      verdict: 'unknown',
      unknown: [{ property: 'verification', reason: 'the verification thread failed: the solver is broken' }],
    });
  });

  it('says whether a prepared input needs a verdict at all, by the one predicate of the verifier', async () => {
    const verifier = createRuleVerifier({ host: installedRuleSolver(import.meta.url), fs: createPolicyFilesystem(), paths, timers: systemTimers, bashPath: () => '/bin/bash', clock: createFakeClock(0) });
    const rule = (text: string, effect: 'allow' | 'deny') => parseRule(text, { effect, origin: 'user', source: '/home/u/.momonga/settings.json', settingsRoot: '/home/u', home: '/home/u', cwd: '/work' } as never);
    expect(await verifier.needsVerdict(await verifier.inputOf({ ...request, rules: [rule('Read(.env)', 'deny')] }, NEVER_CANCELLED))).toBe(false);
    expect(await verifier.needsVerdict(await verifier.inputOf({ ...request, rules: [rule('Read(src/**)', 'allow')] }, NEVER_CANCELLED))).toBe(true);
  });

  it('refuses an input it did not prepare', async () => {
    const verifier = createRuleVerifier({ host: provedRuleSolver({ executables: '/x' }), fs: createPolicyFilesystem(), paths, timers: systemTimers, bashPath: () => '/bin/bash', clock: createFakeClock(0) });
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
    const host: RuleSolverHost = { ...provedRuleSolver({ executables: '/x' }), threadCode: REPORTING_THREAD_CODE };
    const verifier = createRuleVerifier({ host, fs: createPolicyFilesystem(), paths, timers: systemTimers, bashPath: () => '/bin/bash', clock: createFakeClock(0) });
    expect(await verifier.report(await verifier.inputOf(request, NEVER_CANCELLED), new AbortController().signal)).toEqual({
      verdict: { verdict: 'proved', solver: FAKE_SOLVER_VERSION, refuted: [], unknown: [], notProved: [] },
      report: 'policy verification of 0 rule(s)',
    });
  });

  it('gives a report that states the reason when its thread gives no verdict', async () => {
    const host: RuleSolverHost = { ...provedRuleSolver({ executables: '/x' }), threadCode: `throw new Error('the solver is broken')` };
    const verifier = createRuleVerifier({ host, fs: createPolicyFilesystem(), paths, timers: systemTimers, bashPath: () => '/bin/bash', clock: createFakeClock(0) });
    expect((await verifier.report(await verifier.inputOf(request, NEVER_CANCELLED), new AbortController().signal)).report).toBe('The rules were not verified: the verification thread failed: the solver is broken');
  });
});

describe('the rule verifier with the installed solver, in the thread of the product', () => {
  vi.setConfig({ testTimeout: SOLVER_GUARD_MS });

  const verifierIn = (root: string) => createRuleVerifier({ host: installedRuleSolver(import.meta.url), fs: createPolicyFilesystem(), paths: { home: `${root}/home`, root: `${root}/home/.momonga`, keychains: `${root}/home/keys` } as never, timers: systemTimers, bashPath: () => '/bin/bash', clock: createFakeClock(0) });
  const ruleIn = (root: string, text: string, effect: 'allow' | 'deny') => parseRule(text, { effect, origin: 'user', source: `${root}/home/.momonga/settings.json`, settingsRoot: `${root}/home`, home: `${root}/home`, cwd: `${root}/work` } as never);

  it('proves a rule set without a hole, an allow narrowed by a deny included, and refutes an allow that opens a secret location', async (context) => {
    const root = fs.realpathSync(withTempDir(context));
    fs.mkdirSync(`${root}/work`);
    fs.mkdirSync(`${root}/home`);
    const facts = { roots: [`${root}/work`], mode: 'manual', home: `${root}/home`, cwd: `${root}/work`, exemptDirectory: `${root}/home/.momonga/tmp/sessions/s1`, enforcement: 'exact-paths', unixSockets: { kind: 'limited', allowed: [] } } as const;
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

  const homeIn = (context: Parameters<typeof withTempDir>[0]): { root: string; facts: { roots: string[]; home: string; cwd: string; exemptDirectory: string; enforcement: 'exact-paths'; unixSockets: UnixSocketPolicy } } => {
    const root = fs.realpathSync(withTempDir(context));
    fs.mkdirSync(`${root}/work`);
    fs.mkdirSync(`${root}/home/.ssh`, { recursive: true });
    return { root, facts: { roots: [`${root}/work`], home: `${root}/home`, cwd: `${root}/work`, exemptDirectory: `${root}/home/.momonga/tmp/sessions/s1`, enforcement: 'exact-paths', unixSockets: { kind: 'limited', allowed: [] } } };
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
