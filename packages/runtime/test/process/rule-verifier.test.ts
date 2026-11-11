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
import { FAKE_SOLVER_VERSION, provedRuleSolver, provedVerifier } from './fake-rule-solver.ts';

const SOLVER_GUARD_MS = 60 * 60 * 1000;

const request = { rules: [], roots: ['/work'], mode: 'manual', home: '/home/u', cwd: '/work', enforcement: 'exact-paths' } as const;
const paths = { root: '/home/u/.momonga', keychains: '/home/u/keys' } as never;

describe('the rule verifier of the runtime process', () => {
  it('prepares an input with the protected set and the secret locations, and starts no thread for it', async () => {
    const host: RuleSolverHost = {
      ...provedRuleSolver({ executables: '/x' }),
      loadVerifier: async () => ({ ...provedVerifier, secretLocationsOf: (home: string) => [{ label: 'ssh', directory: `${home}/.ssh`, accesses: ['read', 'write'] }] }) as never,
      threadCode: `throw new Error('no thread is expected')`,
    };
    const verifier = createRuleVerifier({ host, fs: createPolicyFilesystem(), paths, timers: systemTimers });
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
    });
    expect(await verifier.verify(await verifier.inputOf(request, NEVER_CANCELLED), new AbortController().signal)).toEqual({ verdict: 'proved', solver: FAKE_SOLVER_VERSION, refuted: [], unknown: [], notProved: [] });
    expect(RULE_VERIFY_LOAD_ALLOWANCE_MS).toBeGreaterThan(0);
    expect(waits).toEqual([RULE_VERIFY_BUDGET_MS + RULE_VERIFY_LOAD_ALLOWANCE_MS]);
  });

  it('gives verdict unknown with the reason when its thread fails', async () => {
    const host: RuleSolverHost = { ...provedRuleSolver({ executables: '/x' }), threadCode: `throw new Error('the solver is broken')` };
    const verifier = createRuleVerifier({ host, fs: createPolicyFilesystem(), paths, timers: systemTimers });
    expect(await verifier.verify(await verifier.inputOf(request, NEVER_CANCELLED), new AbortController().signal)).toMatchObject({
      verdict: 'unknown',
      unknown: [{ property: 'verification', reason: 'the verification thread failed: the solver is broken' }],
    });
  });

  it('refuses an input it did not prepare', async () => {
    const verifier = createRuleVerifier({ host: provedRuleSolver({ executables: '/x' }), fs: createPolicyFilesystem(), paths, timers: systemTimers });
    await expect(verifier.verify({ ...request }, new AbortController().signal)).rejects.toThrow('the rule verifier was given an input it did not prepare');
  });

  it('names the installed solver by its package version', async () => {
    expect(await installedRuleSolver(import.meta.url).solverVersion()).toMatch(/^z3-solver \d+\.\d+\.\d+/);
  });
});

describe('the rule verifier with the installed solver, in the thread of the product', () => {
  vi.setConfig({ testTimeout: SOLVER_GUARD_MS });

  const verifierIn = (root: string) => createRuleVerifier({ host: installedRuleSolver(import.meta.url), fs: createPolicyFilesystem(), paths: { root: `${root}/home/.momonga`, keychains: `${root}/home/keys` } as never, timers: systemTimers });
  const ruleIn = (root: string, text: string, effect: 'allow' | 'deny') => parseRule(text, { effect, origin: 'user', source: `${root}/home/.momonga/settings.json`, settingsRoot: `${root}/home`, home: `${root}/home`, cwd: `${root}/work` } as never);

  it('proves a rule set without a hole, an allow narrowed by a deny included, and refutes an allow that opens a secret location', async (context) => {
    const root = fs.realpathSync(withTempDir(context));
    fs.mkdirSync(`${root}/work`);
    fs.mkdirSync(`${root}/home`);
    const facts = { roots: [`${root}/work`], mode: 'manual', home: `${root}/home`, cwd: `${root}/work`, enforcement: 'exact-paths' } as const;
    const verifier = verifierIn(root);
    const proved = await verifier.verify(await verifier.inputOf({ ...facts, rules: [ruleIn(root, 'Read(//etc/**)', 'deny')] }, NEVER_CANCELLED), new AbortController().signal);
    expect(proved).toMatchObject({ verdict: 'proved', solver: expect.stringMatching(/^z3-solver /), refuted: [], unknown: [] });
    expect(proved.notProved.length).toBeGreaterThan(0);
    const narrowed = await verifier.verify(await verifier.inputOf({ ...facts, rules: [ruleIn(root, 'Bash', 'allow'), ruleIn(root, 'Bash(git push:*)', 'deny')] }, NEVER_CANCELLED), new AbortController().signal);
    expect(narrowed).toMatchObject({ verdict: 'proved', refuted: [], unknown: [] });
    const refuted = await verifier.verify(await verifier.inputOf({ ...facts, rules: [ruleIn(root, 'Read(~/**)', 'allow')] }, NEVER_CANCELLED), new AbortController().signal);
    expect(refuted).toMatchObject({ verdict: 'refuted', refuted: expect.arrayContaining([expect.objectContaining({ property: 'secret-reach' })]) });
  });

  const homeIn = (context: Parameters<typeof withTempDir>[0]): { root: string; facts: { roots: string[]; home: string; cwd: string; enforcement: 'exact-paths' } } => {
    const root = fs.realpathSync(withTempDir(context));
    fs.mkdirSync(`${root}/work`);
    fs.mkdirSync(`${root}/home/.ssh`, { recursive: true });
    return { root, facts: { roots: [`${root}/work`], home: `${root}/home`, cwd: `${root}/work`, enforcement: 'exact-paths' } };
  };

  it.for(PERMISSION_MODES)('refuses no run in the %s mode when no rule is written: what the mode default alone opens is recorded as by the mode default', async (mode, context) => {
    const { root, facts } = homeIn(context);
    const verifier = verifierIn(root);
    const verdict = await verifier.verify(await verifier.inputOf({ ...facts, mode, rules: [] }, NEVER_CANCELLED), new AbortController().signal);
    expect(verdict.refuted).toEqual([]);
    expect(verdict.verdict).not.toBe('refuted');
    expect(policyRefusal({ fingerprint: 'f'.repeat(64), ...verdict })).toBeUndefined();
    if (mode === 'bypassPermissions') {
      expect(verdict.byModeDefault).toEqual(expect.arrayContaining([expect.objectContaining({ property: 'secret-reach', message: expect.stringContaining('by the mode default') })]));
    } else {
      expect(verdict).not.toHaveProperty('byModeDefault');
    }
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
