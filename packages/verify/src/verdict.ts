import type { RuleVerdict } from '@momonga/protocol';
import { describeWitness } from './report.ts';
import type { VerificationReport } from './report.ts';
import type { VerifyRequest } from './verify.ts';

export type RuleVerifyInput = Pick<VerifyRequest, 'rules' | 'roots' | 'mode' | 'home' | 'cwd' | 'enforcement' | 'protectedSet' | 'secretLocations'>;

export const ruleVerifyInputOf = ({ rules, roots, mode, home, cwd, enforcement, protectedSet, secretLocations }: RuleVerifyInput): RuleVerifyInput => ({
  rules,
  roots,
  mode,
  home,
  cwd,
  enforcement,
  protectedSet,
  secretLocations,
});

export const verdictOfReport = (report: VerificationReport, solver: string): RuleVerdict => {
  const refuted = report.results.flatMap((result) =>
    result.verdict.status === 'refuted'
      ? result.verdict.findings.map((finding) => ({
          property: result.id,
          subject: finding.subject,
          message: finding.message,
          ...(finding.counterexample === undefined ? {} : { counterexample: describeWitness(finding.counterexample.witness) }),
        }))
      : [],
  );
  const unknown = [
    ...report.results.flatMap((result) => (result.verdict.status === 'unknown' ? [{ property: result.id, reason: result.verdict.reason }] : [])),
    ...report.mismatches.map((mismatch) => ({
      property: mismatch.property,
      reason: `the model and the decision code disagree on ${describeWitness(mismatch.counterexample.witness)}`,
    })),
  ];
  return { verdict: refuted.length > 0 ? 'refuted' : unknown.length > 0 ? 'unknown' : 'proved', solver, refuted, unknown, notProved: [...report.outsideProof] };
};
