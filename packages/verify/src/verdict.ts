import { protectedSetFor, verdictSubjectOf } from '@momonga/foundation';
import type { ProtectedSet } from '@momonga/foundation';
import { askedBy } from '@momonga/policy';
import type { PolicyHostFilesystem } from '@momonga/policy';
import { refusingRefutations } from '@momonga/protocol';
import type { RuleRefutation, RuleVerdict, RuleVerdictKind } from '@momonga/protocol';
import { describeWitness, isMismatch } from './report.ts';
import type { Finding, VerificationReport } from './report.ts';
import type { VerifyRequest } from './verify.ts';

export type RuleVerifyInput = Pick<VerifyRequest, 'rules' | 'roots' | 'mode' | 'home' | 'cwd' | 'exemptDirectory' | 'enforcement' | 'protectedSet' | 'secretLocations'>;

export const ruleVerifyInputOf = (facts: RuleVerifyInput): RuleVerifyInput => verdictSubjectOf(facts);

const refutationOf = (property: string, finding: Finding): RuleRefutation => ({
  property,
  subject: finding.subject,
  message: finding.message,
  ...(finding.counterexample === undefined ? {} : { counterexample: describeWitness(finding.counterexample.witness) }),
});

const confirmed = (finding: Finding): boolean => finding.counterexample === undefined || !isMismatch(finding.counterexample.replay);

const kindOf = (refuted: RuleRefutation[], mismatches: number, undecided: number): RuleVerdictKind => {
  if (refusingRefutations({ refuted }).length > 0) return 'refuted';
  if (mismatches > 0) return 'failed';
  return undecided > 0 ? 'unknown' : 'proved';
};

export const verdictOfReport = (report: VerificationReport, solver: string): RuleVerdict => {
  const refuted = report.results.flatMap((result) => (result.verdict.status === 'refuted' ? result.verdict.findings.filter(confirmed).map((finding) => refutationOf(result.id, finding)) : []));
  const notes = report.results.flatMap((result) => (result.verdict.status === 'noted' ? result.verdict.ruleNotes : []));
  const byModeDefault = report.results.flatMap((result) => result.byModeDefault.map((finding) => refutationOf(result.id, finding)));
  const undecided = report.results.flatMap((result) => (result.verdict.status === 'unknown' ? [{ property: result.id, reason: result.verdict.reason }] : []));
  const mismatched = report.mismatches.map((mismatch) => ({
    property: mismatch.property,
    reason: `the model and the decision code disagree on ${describeWitness(mismatch.counterexample.witness)}`,
  }));
  return {
    verdict: kindOf(refuted, mismatched.length, undecided.length),
    solver,
    refuted,
    ...(notes.length === 0 ? {} : { notes }),
    ...(byModeDefault.length === 0 ? {} : { byModeDefault }),
    unknown: [...undecided, ...mismatched],
    notProved: [...report.outsideProof],
    ...(report.timings.length === 0 ? {} : { phases: [...report.timings] }),
  };
};

export const protectedSetOf = (roots: readonly string[], fs: PolicyHostFilesystem, signal: AbortSignal): Promise<ProtectedSet> => protectedSetFor(roots, askedBy(fs, signal));
