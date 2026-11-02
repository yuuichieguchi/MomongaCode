import type { GoldenCase, GoldenDataset, PermissionDecision } from './dataset.ts';
import type { DecisionObservation, GradeOutcome, Graded } from './graders.ts';
import { proportionOf } from './stats.ts';
import type { Proportion } from './stats.ts';

export type RunVerdict = { runIndex: number; runId: string; passed: boolean; failures: GradeOutcome[] };

export type CaseResult = { golden: GoldenCase; runs: { runIndex: number; runId: string; graded: Graded }[] };

export type CaseReport = {
  id: string;
  passRate: Proportion;
  minPassRate: number;
  meetsMinimum: boolean;
  verdicts: RunVerdict[];
};

export type DecisionReport = {
  falseAllow: Proportion | undefined;
  falseBlock: Proportion | undefined;
  unobserved: number;
};

export type EvalReport = {
  dataset: string;
  cases: CaseReport[];
  overall: Proportion;
  decisions: DecisionReport;
  passed: boolean;
};

const MUST_NOT_ALLOW: readonly PermissionDecision[] = ['ask', 'deny'];

export const proportionOrUndefined = (successes: number, trials: number): Proportion | undefined => (trials === 0 ? undefined : proportionOf(successes, trials));

type DirectionUnit = { labelled: boolean; observed: boolean; wrong: boolean };

const isObserved = (entry: DecisionObservation): boolean => entry.observed !== 'not_called' && entry.observed !== 'unresolved';

const unitOf = (observations: readonly DecisionObservation[], matches: (entry: DecisionObservation) => boolean, isWrong: (entry: DecisionObservation) => boolean): DirectionUnit => {
  const labelled = observations.filter(matches);
  const observed = labelled.filter(isObserved);
  return { labelled: labelled.length > 0, observed: observed.length > 0, wrong: observed.some(isWrong) };
};

const proportionOfUnits = (units: readonly DirectionUnit[]): Proportion | undefined => {
  const observed = units.filter((unit) => unit.observed);
  return proportionOrUndefined(observed.filter((unit) => unit.wrong).length, observed.length);
};

const decisionReportOf = (runs: readonly (readonly DecisionObservation[])[]): DecisionReport => {
  const mustNotAllow = runs.map((observations) =>
    unitOf(observations, (entry) => MUST_NOT_ALLOW.includes(entry.expected), (entry) => entry.observed === 'allow'),
  );
  const mustAllow = runs.map((observations) => unitOf(observations, (entry) => entry.expected === 'allow', (entry) => entry.observed !== 'allow'));
  return {
    falseAllow: proportionOfUnits(mustNotAllow),
    falseBlock: proportionOfUnits(mustAllow),
    unobserved: [...mustNotAllow, ...mustAllow].filter((unit) => unit.labelled && !unit.observed).length,
  };
};

const caseReportOf = (result: CaseResult): CaseReport => {
  const passes = result.runs.filter((run) => run.graded.passed).length;
  const passRate = proportionOf(passes, result.runs.length);
  return {
    id: result.golden.id,
    passRate,
    minPassRate: result.golden.minPassRate,
    meetsMinimum: passRate.rate >= result.golden.minPassRate,
    verdicts: result.runs.map((run) => ({
      runIndex: run.runIndex,
      runId: run.runId,
      passed: run.graded.passed,
      failures: run.graded.outcomes.filter((outcome) => outcome.kind === 'fail'),
    })),
  };
};

export const buildReport = (dataset: GoldenDataset, results: readonly CaseResult[]): EvalReport => {
  const cases = results.map(caseReportOf);
  const totalRuns = results.reduce((sum, result) => sum + result.runs.length, 0);
  const passedRuns = results.reduce((sum, result) => sum + result.runs.filter((run) => run.graded.passed).length, 0);
  return {
    dataset: dataset.name,
    cases,
    overall: proportionOf(passedRuns, totalRuns),
    decisions: decisionReportOf(results.flatMap((result) => result.runs.map((run) => run.graded.decisions))),
    passed: cases.every((entry) => entry.meetsMinimum),
  };
};

export const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

export const describeProportion = (proportion: Proportion): string =>
  `${proportion.successes}/${proportion.trials} = ${percent(proportion.rate)} (95% Wilson ${percent(proportion.low)}..${percent(proportion.high)})`;

export const formatReport = (report: EvalReport): string => {
  const lines = [`dataset ${report.dataset}: ${report.passed ? 'PASS' : 'FAIL'}`];
  for (const entry of report.cases) {
    lines.push(`  ${entry.meetsMinimum ? 'ok  ' : 'FAIL'} ${entry.id}: pass rate ${describeProportion(entry.passRate)}, required at least ${percent(entry.minPassRate)}`);
    for (const verdict of entry.verdicts.filter((run) => !run.passed)) {
      for (const failure of verdict.failures) lines.push(`         run ${verdict.runIndex} (${verdict.runId}) ${failure.grader}: ${failure.detail}`);
    }
  }
  lines.push(`overall pass rate ${describeProportion(report.overall)}`);
  const { falseAllow, falseBlock, unobserved } = report.decisions;
  lines.push(`false-allow rate ${falseAllow === undefined ? 'n/a (no decision labelled ask or deny was observed)' : describeProportion(falseAllow)}`);
  lines.push(`false-block rate ${falseBlock === undefined ? 'n/a (no decision labelled allow was observed)' : describeProportion(falseBlock)}`);
  lines.push(`unobserved decisions ${unobserved}`);
  return lines.join('\n');
};
