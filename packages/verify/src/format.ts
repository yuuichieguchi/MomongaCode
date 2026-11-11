import { escapeTerminalLine } from '@momonga/protocol';
import { describeWitness } from './report.ts';
import type { Counterexample, PropertyResult, Replay, VerificationReport } from './report.ts';

const STATUS_LABEL = { proved: 'PROVED ', noted: 'NOTES  ', refuted: 'REFUTED', unknown: 'UNKNOWN' } as const;

const describeReplay = (replay: Replay): string => {
  if ('skipped' in replay) return `not compared with the decision code: ${replay.skipped}`;
  if ('crashed' in replay) return `MODEL MISMATCH: the decision code failed on this input (${replay.crashed})`;
  if (replay.agrees) return `the decision code agrees (${replay.actual})`;
  return `MODEL MISMATCH: the model predicted ${replay.predicted} but the decision code returned ${replay.actual}`;
};

const describeCounterexample = (counterexample: Counterexample): string[] => [
  `    counterexample: ${describeWitness(counterexample.witness)}`,
  `    model: ${counterexample.predicted}, ${counterexample.cause}`,
  `    replay: ${describeReplay(counterexample.replay)}`,
];

const describeResult = (result: PropertyResult): string[] => {
  const { verdict } = result;
  const lines = [`[${STATUS_LABEL[verdict.status]}] ${result.title} (${result.subject})`, `  proves: ${result.proves}`];
  if (verdict.status === 'refuted') {
    for (const finding of verdict.findings) {
      lines.push(`  - ${finding.subject}: ${finding.message}`);
      if (finding.counterexample !== undefined) lines.push(...describeCounterexample(finding.counterexample));
    }
  }
  if (verdict.status === 'unknown') lines.push(`  undecided: ${verdict.reason}`);
  for (const finding of result.byModeDefault) {
    lines.push(`  by the mode default, not by a rule: ${finding.subject}: ${finding.message}`);
    if (finding.counterexample !== undefined) lines.push(...describeCounterexample(finding.counterexample));
  }
  for (const note of verdict.notes) lines.push(`  note: ${note}`);
  lines.push(`  does not prove: ${result.doesNotProve.join('; ')}`);
  return lines;
};

export const formatReport = (report: VerificationReport): string => {
  const lines = [`policy verification of ${report.ruleCount} rule(s) in ${report.mode} mode with ${report.solver}`, ''];
  for (const result of report.results) lines.push(...describeResult(result), '');
  if (report.mismatches.length > 0) {
    lines.push(`${report.mismatches.length} counterexample(s) disagree with the decision code, so the model does not match the implementation there:`);
    for (const mismatch of report.mismatches) lines.push(`  - ${mismatch.property}: ${mismatch.subject}`, ...describeCounterexample(mismatch.counterexample));
    lines.push('');
  }
  lines.push('Outside the proof:');
  for (const item of report.outsideProof) lines.push(`  - ${item}`);
  return lines.map(escapeTerminalLine).join('\n');
};
