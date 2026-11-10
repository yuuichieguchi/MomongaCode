import { escapeTerminalLine, usdOfNano } from '@momonga/protocol';
import { budgetMetricsOf, mandateMetricsOf } from './budget-metrics.ts';
import type { BudgetMetrics, MandateMetrics, RunFiguresOfEval } from './budget-metrics.ts';
import type { GoldenCase, GoldenDataset, PermissionDecision } from './dataset.ts';
import type { DecisionObservation, GradeOutcome, Graded } from './graders.ts';
import { completionAgreement } from './oracle.ts';
import type { Agreement, GateVerdict } from './oracle.ts';
import { proportionOf } from './stats.ts';
import type { Proportion } from './stats.ts';

export type RunVerdict = { runIndex: number; runId: string; passed: boolean; failures: GradeOutcome[] };

export type CompletionObservation = { gate: GateVerdict; oracle: boolean };

export type CaseResult = { golden: GoldenCase; runs: { runIndex: number; runId: string; graded: Graded; completion?: CompletionObservation; figures: RunFiguresOfEval }[] };

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
  completion?: Agreement;
  budget?: BudgetMetrics;
  mandate?: MandateMetrics;
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
  const completionRows = results.flatMap((result) => result.runs.flatMap((run) => (run.completion === undefined ? [] : [run.completion])));
  const cases = results.map(caseReportOf);
  const totalRuns = results.reduce((sum, result) => sum + result.runs.length, 0);
  const figures = results.flatMap((result) => result.runs.map((run) => run.figures));
  const budget = budgetMetricsOf(figures.map((entry) => entry.budget));
  const mandate = mandateMetricsOf(figures.flatMap((entry) => (entry.mandate === undefined ? [] : [entry.mandate])));
  const passedRuns = results.reduce((sum, result) => sum + result.runs.filter((run) => run.graded.passed).length, 0);
  return {
    dataset: dataset.name,
    cases,
    overall: proportionOf(passedRuns, totalRuns),
    decisions: decisionReportOf(results.flatMap((result) => result.runs.map((run) => run.graded.decisions))),
    ...(completionRows.length === 0 ? {} : { completion: completionAgreement(completionRows) }),
    ...(budget === undefined ? {} : { budget }),
    ...(mandate === undefined ? {} : { mandate }),
    passed: cases.every((entry) => entry.meetsMinimum),
  };
};

export const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

export const describeProportion = (proportion: Proportion): string =>
  `${proportion.successes}/${proportion.trials} = ${percent(proportion.rate)} (95% Wilson ${percent(proportion.low)}..${percent(proportion.high)})`;

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

const describeRate = (rate: Proportion | undefined, none: string): string => (rate === undefined ? `n/a (${none})` : describeProportion(rate));

const budgetLines = (budget: BudgetMetrics): string[] => [
  `budget overrun rate ${describeRate(budget.overrun, 'no run has a token or money limit')}`,
  `runs with a limit ${budget.limitedRuns}, without ${budget.unlimitedRuns}; runs with a model call that has no price ${budget.runsWithUnpricedCalls}`,
  `budget stops: ${budget.stops.length === 0 ? 'none' : budget.stops.map((stop) => `${stop.dimension} ${stop.cause} ${stop.count}`).join(', ')}`,
  `cost per run whose completion gate passed: ${budget.costPerSuccess.meanNano === null ? 'n/a (no run passed its completion gate)' : `${usdOfNano(Math.ceil(budget.costPerSuccess.meanNano))} USD over ${plural(budget.costPerSuccess.runs, 'run', 'runs')}`}`,
  `unspent share of the limit at a budget stop: ${budget.unspentShareAtStop.mean === null ? 'n/a (no budget stop)' : `${percent(budget.unspentShareAtStop.mean)} over ${plural(budget.unspentShareAtStop.stops, 'stop', 'stops')}`}`,
];

const mandateLines = (mandate: MandateMetrics): string[] => [
  `mandate runs ${mandate.runs}`,
  `human intervention rate ${describeRate(mandate.intervention, 'no mandate run ended')}`,
  `unattended completion ${describeRate(mandate.unattended, 'no mandate run ended')}`,
  `mandate runs that waited for a person ${describeRate(mandate.waitedForPerson, 'no mandate run ended')}`,
  `approval timeout rate ${describeRate(mandate.approvalTimeout, 'no mandate run ended')}`,
  `calls held ${mandate.held}, denied as outside the mandate ${mandate.deniedOutsideMandate} (${mandate.deniedOutsideMandatePerRun} per run), blocked by a held call ${mandate.blockedByHeldCall}`,
  `work done while a call was held: ${plural(mandate.workDuringHolds.modelSteps, 'model step', 'model steps')}, ${plural(mandate.workDuringHolds.toolCalls, 'tool call', 'tool calls')}`,
  `time from a hold to its resolution by a person: ${mandate.holdLatency.meanMs === null ? 'n/a (no hold was resolved by a person)' : `${Math.round(mandate.holdLatency.meanMs)} ms mean over ${plural(mandate.holdLatency.holds, 'hold', 'holds')}`}`,
];

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
  if (report.completion !== undefined) {
    const agreement = report.completion;
    lines.push(
      `completion gate against the oracle: passed with the oracle met ${agreement.gatePassOraclePass}, passed with the oracle unmet ${agreement.gatePassOracleFail} (false pass), failed with the oracle met ${agreement.gateFailOraclePass}, failed with the oracle unmet ${agreement.gateFailOracleFail}, no gate verdict ${agreement.gateNotRun}`,
    );
  }
  if (report.budget !== undefined) lines.push(...budgetLines(report.budget));
  if (report.mandate !== undefined) lines.push(...mandateLines(report.mandate));
  return lines.map(escapeTerminalLine).join('\n');
};
