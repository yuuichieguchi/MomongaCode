import { protectedSetFor } from '@momonga/foundation';
import type { ProtectedSet } from '@momonga/foundation';
import { askedBy } from '@momonga/policy';
import type { PolicyHostFilesystem } from '@momonga/policy';
import type { RuleRefutation, RuleVerdict } from '@momonga/protocol';
import { describeWitness } from './report.ts';
import type { Finding, VerificationReport } from './report.ts';
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

const refutationOf = (property: string, finding: Finding): RuleRefutation => ({
  property,
  subject: finding.subject,
  message: finding.message,
  ...(finding.counterexample === undefined ? {} : { counterexample: describeWitness(finding.counterexample.witness) }),
});

export const verdictOfReport = (report: VerificationReport, solver: string): RuleVerdict => {
  const refuted = report.results.flatMap((result) => (result.verdict.status === 'refuted' ? result.verdict.findings.map((finding) => refutationOf(result.id, finding)) : []));
  const notes = report.results.flatMap((result) => (result.verdict.status === 'noted' ? result.verdict.ruleNotes : []));
  const byModeDefault = report.results.flatMap((result) => result.byModeDefault.map((finding) => refutationOf(result.id, finding)));
  const unknown = [
    ...report.results.flatMap((result) => (result.verdict.status === 'unknown' ? [{ property: result.id, reason: result.verdict.reason }] : [])),
    ...report.mismatches.map((mismatch) => ({
      property: mismatch.property,
      reason: `the model and the decision code disagree on ${describeWitness(mismatch.counterexample.witness)}`,
    })),
  ];
  return {
    verdict: refuted.length > 0 ? 'refuted' : unknown.length > 0 ? 'unknown' : 'proved',
    solver,
    refuted,
    ...(notes.length === 0 ? {} : { notes }),
    ...(byModeDefault.length === 0 ? {} : { byModeDefault }),
    unknown,
    notProved: [...report.outsideProof],
  };
};

export const protectedSetOf = (roots: readonly string[], fs: PolicyHostFilesystem, signal: AbortSignal): Promise<ProtectedSet> => protectedSetFor(roots, askedBy(fs, signal));
