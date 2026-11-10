import { describe, expect, it } from 'vitest';
import { ruleVerifyInputOf, verdictOfReport } from '../src/verdict.ts';
import type { VerificationReport } from '../src/report.ts';

const result = (id: string, verdict: unknown) => ({ id, title: id, subject: 'Read', proves: '', doesNotProve: [], verdict });
const reportOf = (results: unknown[], mismatches: unknown[] = []): VerificationReport =>
  ({ mode: 'manual', ruleCount: 1, solver: 'Z3 4', results, mismatches, outsideProof: ['shell commands'], exitCode: 1 }) as unknown as VerificationReport;
const witness = { kind: 'path', tool: 'Read', requested: '/work/a', resolved: '/work/a' };

describe('the verdict of a verification report', () => {
  it('is proved when every property is proved, with the list of what is not proved', () => {
    expect(verdictOfReport(reportOf([result('deny-precedence', { status: 'proved', notes: [] })]), 'z3 1')).toEqual({ verdict: 'proved', solver: 'z3 1', refuted: [], unknown: [], notProved: ['shell commands'] });
  });

  it('is refuted when a property is refuted, naming the property, the subject, the message and the counterexample', () => {
    const report = reportOf([
      result('deny-precedence', { status: 'refuted', notes: [], findings: [{ subject: 'Read', message: 'a hole', counterexample: { witness } }, { subject: 'Write', message: 'another' }] }),
      result('bash-admission', { status: 'unknown', reason: 'the verification budget of 60000 ms was spent', notes: [] }),
    ]);
    const verdict = verdictOfReport(report, 'z3 1');
    expect(verdict).toMatchObject({
      verdict: 'refuted',
      refuted: [
        { property: 'deny-precedence', subject: 'Read', message: 'a hole', counterexample: expect.stringContaining('/work/a') },
        { property: 'deny-precedence', subject: 'Write', message: 'another' },
      ],
      unknown: [{ property: 'bash-admission', reason: 'the verification budget of 60000 ms was spent' }],
    });
    expect(verdict.refuted[1]).not.toHaveProperty('counterexample');
  });

  it('is unknown when a property is undecided or the model disagrees with the decision code', () => {
    expect(verdictOfReport(reportOf([result('bash-admission', { status: 'unknown', reason: 'budget', notes: [] })]), 'z3 1').verdict).toBe('unknown');
    const mismatched = verdictOfReport(reportOf([result('deny-precedence', { status: 'proved', notes: [] })], [{ property: 'deny-precedence', subject: 'Read', counterexample: { witness } }]), 'z3 1');
    expect(mismatched).toMatchObject({ verdict: 'unknown', unknown: [{ property: 'deny-precedence', reason: expect.stringMatching(/^the model and the decision code disagree on .*\/work\/a/) }] });
  });
});

describe('the input a verdict is stored under', () => {
  it('holds the verified facts and nothing of the way they were verified', () => {
    const facts = { rules: [], roots: ['/work'], mode: 'manual', home: '/home/u', cwd: '/work', enforcement: 'exact-paths', protectedSet: { paths: [] }, secretLocations: [] };
    const given = { ...facts, fs: { canonicalise: () => undefined }, budgetMs: 5, exemptDirectory: null, clock: { now: () => 0 } };
    expect(ruleVerifyInputOf(given as never)).toEqual(facts);
  });
});
