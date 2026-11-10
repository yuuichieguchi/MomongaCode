import { describe, expect, it } from 'vitest';
import { RULE_VERIFY_BUDGET_MS } from '@momonga/protocol';
import { createPolicyFilesystem } from '@momonga/tools';
import { createRuleVerifier, installedRuleSolver, verdictOfReport } from '../../src/process/rule-verifier.ts';
import type { RuleSolverHost } from '../../src/process/rule-verifier.ts';

type Verifier = Awaited<ReturnType<RuleSolverHost['loadVerifier']>>;
type Report = Awaited<ReturnType<Verifier['verifyPermissions']>>;

const describeWitness = (witness: { kind: string }): string => `witness ${witness.kind}`;
const result = (id: string, verdict: unknown) => ({ id, title: id, subject: 'Read', proves: '', doesNotProve: [], verdict });
const reportOf = (results: unknown[], mismatches: unknown[] = []): Report => ({ mode: 'manual', ruleCount: 1, solver: 'Z3 4', results, mismatches, outsideProof: ['shell commands'], exitCode: 1 }) as unknown as Report;
const witness = { kind: 'path' };

describe('the verdict of a verification report', () => {
  it('is proved when every property is proved, with the list of what is not proved', () => {
    expect(verdictOfReport({ describeWitness } as never, reportOf([result('deny-precedence', { status: 'proved', notes: [] })]), 'z3 1')).toEqual({ verdict: 'proved', solver: 'z3 1', refuted: [], unknown: [], notProved: ['shell commands'] });
  });

  it('is refuted when a property is refuted, naming the property, the subject, the message and the counterexample', () => {
    const report = reportOf([
      result('deny-precedence', { status: 'refuted', notes: [], findings: [{ subject: 'Read', message: 'a hole', counterexample: { witness } }, { subject: 'Write', message: 'another' }] }),
      result('bash-admission', { status: 'unknown', reason: 'the verification budget of 60000 ms was spent', notes: [] }),
    ]);
    expect(verdictOfReport({ describeWitness } as never, report, 'z3 1')).toMatchObject({
      verdict: 'refuted',
      refuted: [
        { property: 'deny-precedence', subject: 'Read', message: 'a hole', counterexample: 'witness path' },
        { property: 'deny-precedence', subject: 'Write', message: 'another' },
      ],
      unknown: [{ property: 'bash-admission', reason: 'the verification budget of 60000 ms was spent' }],
    });
  });

  it('is unknown when a property is undecided or the model disagrees with the decision code', () => {
    expect(verdictOfReport({ describeWitness } as never, reportOf([result('bash-admission', { status: 'unknown', reason: 'budget', notes: [] })]), 'z3 1').verdict).toBe('unknown');
    const mismatched = verdictOfReport({ describeWitness } as never, reportOf([result('deny-precedence', { status: 'proved', notes: [] })], [{ property: 'deny-precedence', subject: 'Read', counterexample: { witness } }]), 'z3 1');
    expect(mismatched).toMatchObject({ verdict: 'unknown', unknown: [{ property: 'deny-precedence', reason: 'the model and the decision code disagree on witness path' }] });
  });
});

describe('the rule verifier of the runtime process', () => {
  const request = { rules: [], roots: ['/work'], mode: 'manual', home: '/home/u', cwd: '/work', enforcement: 'exact-paths' } as const;
  const hostOf = (calls: { opened: number; closed: number; budgets: number[] }): RuleSolverHost => ({
    solverVersion: async () => 'z3 1',
    loadVerifier: async () =>
      ({
        describeWitness,
        secretLocationsOf: (home: string) => [{ label: 'ssh', directory: `${home}/.ssh`, accesses: ['read', 'write'] }],
        verifyPermissions: async (_api: unknown, given: { budgetMs: number }) => {
          calls.budgets.push(given.budgetMs);
          return reportOf([result('deny-precedence', { status: 'proved', notes: [] })]);
        },
      }) as never,
    openSolver: async () => {
      calls.opened += 1;
      return { api: {} as never, close: async () => void (calls.closed += 1) };
    },
  });

  it('prepares an input with the protected set and the secret locations without opening the solver, then verifies under the budget and closes the solver', async () => {
    const calls = { opened: 0, closed: 0, budgets: [] as number[] };
    const verifier = createRuleVerifier({ host: hostOf(calls), fs: createPolicyFilesystem(), paths: { root: '/home/u/.momonga', keychains: '/home/u/keys' } as never });
    const input = await verifier.inputOf(request);
    expect(input).toMatchObject({ ...request, secretLocations: [{ directory: '/home/u/.ssh' }], protectedSet: expect.any(Object) });
    expect(calls.opened).toBe(0);
    expect(await verifier.verify(input, new AbortController().signal)).toMatchObject({ verdict: 'proved', solver: 'z3 1' });
    expect(calls).toEqual({ opened: 1, closed: 1, budgets: [RULE_VERIFY_BUDGET_MS] });
  });

  it('refuses an input it did not prepare', async () => {
    const verifier = createRuleVerifier({ host: hostOf({ opened: 0, closed: 0, budgets: [] }), fs: createPolicyFilesystem(), paths: { root: '/r', keychains: '/k' } as never });
    await expect(verifier.verify({ ...request }, new AbortController().signal)).rejects.toThrow('the rule verifier was given an input it did not prepare');
  });

  it('names the installed solver by its package version', async () => {
    expect(await installedRuleSolver(import.meta.url).solverVersion()).toMatch(/^z3-solver \d+\.\d+\.\d+/);
  });
});
