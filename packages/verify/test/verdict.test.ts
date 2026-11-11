import { describe, expect, it } from 'vitest';
import { ruleVerifyInputOf, verdictOfReport } from '../src/verdict.ts';
import type { VerificationReport } from '../src/report.ts';

const result = (id: string, verdict: unknown) => ({ id, title: id, subject: 'Read', proves: '', doesNotProve: [], verdict });
const reportOf = (results: unknown[], mismatches: unknown[] = []): VerificationReport =>
  ({ mode: 'manual', ruleCount: 1, solver: 'Z3 4', results, mismatches, timings: [], outsideProof: ['shell commands'], exitCode: 1 }) as unknown as VerificationReport;
const witness = { kind: 'path', tool: 'Read', requested: '/work/a', resolved: '/work/a' };
const agreed = { witness, replay: { agrees: true, actual: 'allow', final: 'allow' } };
const disagreed = { witness, replay: { agrees: false, predicted: 'allow', actual: 'ask', final: 'ask' } };
const spent = { status: 'unknown', reason: 'the verification budget of 60000 ms was spent', notes: [] };

describe('the verdict of a verification report', () => {
  it('is proved when every property is proved, with the list of what is not proved', () => {
    expect(verdictOfReport(reportOf([result('deny-precedence', { status: 'proved', notes: [] })]), 'z3 1')).toEqual({ verdict: 'proved', solver: 'z3 1', refuted: [], unknown: [], notProved: ['shell commands'] });
  });

  it.each(['secret-reach', 'superseded-forms', 'mandate-holds'])('is refuted when %s is refuted, and keeps the refutation when a later property spends the budget', (property) => {
    const report = reportOf([
      result(property, { status: 'refuted', notes: [], findings: [{ subject: 'Read', message: 'a hole', counterexample: agreed }, { subject: 'Write', message: 'another' }] }),
      result('bash-admission', spent),
    ]);
    const verdict = verdictOfReport(report, 'z3 1');
    expect(verdict).toMatchObject({
      verdict: 'refuted',
      refuted: [
        { property, subject: 'Read', message: 'a hole', counterexample: expect.stringContaining('/work/a') },
        { property, subject: 'Write', message: 'another' },
      ],
      unknown: [{ property: 'bash-admission', reason: 'the verification budget of 60000 ms was spent' }],
    });
    expect(verdict.refuted[1]).not.toHaveProperty('counterexample');
  });

  it.each(['deny-precedence', 'bash-admission'])('is not refuted by a finding of %s, which refuses no run: the finding is listed and the kind follows the other properties', (property) => {
    const finding = result(property, { status: 'refuted', notes: [], findings: [{ subject: 'Bash', message: 'a hole', counterexample: agreed }] });
    expect(verdictOfReport(reportOf([finding]), 'z3 1')).toMatchObject({ verdict: 'proved', refuted: [{ property, subject: 'Bash', message: 'a hole' }] });
    expect(verdictOfReport(reportOf([finding, result('secret-reach', spent)]), 'z3 1')).toMatchObject({ verdict: 'unknown', refuted: [{ property }] });
  });

  it('is unknown when a property is undecided', () => {
    expect(verdictOfReport(reportOf([result('bash-admission', { status: 'unknown', reason: 'budget', notes: [] })]), 'z3 1').verdict).toBe('unknown');
  });

  it('is failed when the model and the decision code disagree, names the witness, and counts no finding the decision code contradicts', () => {
    const mismatch = { property: 'secret-reach', subject: 'Read', counterexample: disagreed };
    const proved = verdictOfReport(reportOf([result('deny-precedence', { status: 'proved', notes: [] })], [mismatch]), 'z3 1');
    expect(proved).toMatchObject({ verdict: 'failed', refuted: [], unknown: [{ property: 'secret-reach', reason: expect.stringMatching(/^the model and the decision code disagree on .*\/work\/a/) }] });
    const contradicted = verdictOfReport(reportOf([result('secret-reach', { status: 'refuted', notes: [], findings: [{ subject: 'Read', message: 'a hole', counterexample: disagreed }] })], [mismatch]), 'z3 1');
    expect(contradicted).toMatchObject({ verdict: 'failed', refuted: [] });
  });

  it('stays refuted when the decision code confirms one finding and contradicts another', () => {
    const report = reportOf(
      [result('secret-reach', { status: 'refuted', notes: [], findings: [{ subject: 'Read', message: 'confirmed', counterexample: agreed }, { subject: 'Write', message: 'contradicted', counterexample: disagreed }] })],
      [{ property: 'secret-reach', subject: 'Write', counterexample: disagreed }],
    );
    expect(verdictOfReport(report, 'z3 1')).toMatchObject({ verdict: 'refuted', refuted: [{ message: 'confirmed' }] });
    expect(verdictOfReport(report, 'z3 1').refuted).toHaveLength(1);
  });
});

describe('the input a verdict is stored under', () => {
  it('holds the verified facts, the exempt scratch folder included and each root once, and nothing of the way they were verified', () => {
    const facts = { rules: [], roots: ['/work'], mode: 'manual', home: '/home/u', cwd: '/work', exemptDirectory: '/home/u/.momonga/tmp/sessions/s1', enforcement: 'exact-paths', protectedSet: { paths: [] }, secretLocations: [] };
    const given = { ...facts, roots: ['/work', '/work'], fs: { canonicalise: () => undefined }, budgetMs: 5, clock: { now: () => 0 } };
    expect(ruleVerifyInputOf(given as never)).toEqual(facts);
  });
});
