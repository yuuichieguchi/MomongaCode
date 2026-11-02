import { MINIMUM_PAIRS, pairedBootstrap } from './bootstrap.ts';
import type { BootstrapInterval } from './bootstrap.ts';
import { describeClustered } from './context-report.ts';
import type { ClusteredProportion, ContextCaseReport, ContextReport } from './context-report.ts';
import { percent } from './report.ts';
import { EvalError } from './runner.ts';

export const GATE_CHECKS = [
  'real_model',
  'contrastiveFailures',
  'fabricationRate',
  'lossSignalsPerCompaction',
  'tokensPerSuccess',
  'offCases',
  'overallPasses',
  'unclassifiedCompactions',
] as const;
export type GateCheckName = (typeof GATE_CHECKS)[number];

export type GateCheck = { name: GateCheckName; passed: boolean; detail: string };

export type ContextComparison = {
  baseline: { dataset: string; model: ContextReport['model'] };
  candidate: { dataset: string; model: ContextReport['model'] };
  contrastiveFailures: { baseline: number; candidate: number; n: number };
  fabricationRate: { baseline: ClusteredProportion | undefined; candidate: ClusteredProportion | undefined };
  differences: { lossSignalsPerCompaction: BootstrapInterval | undefined; tokensPerSuccess: BootstrapInterval | undefined };
  gate: { passed: boolean; checks: GateCheck[] };
};

type CasePair = { baseline: ContextCaseReport; candidate: ContextCaseReport };

const pairCases = (baseline: ContextReport, candidate: ContextReport): CasePair[] => {
  if (baseline.datasetDigest !== candidate.datasetDigest) {
    throw new EvalError('the reports measure different datasets (their digests differ), so a difference between them says nothing about the candidate');
  }
  if (baseline.cases.length !== candidate.cases.length) {
    throw new EvalError(`the reports cover ${baseline.cases.length} and ${candidate.cases.length} cases, so they cannot be paired`);
  }
  return baseline.cases.map((entry) => {
    const other = candidate.cases.find((match) => match.id === entry.id);
    if (other === undefined) throw new EvalError(`case ${entry.id} is missing from the candidate report, so the reports cannot be paired`);
    if (other.scenario !== entry.scenario || other.compaction !== entry.compaction || other.runs !== entry.runs) {
      throw new EvalError(`case ${entry.id} differs between the reports in scenario, compaction or runs, so they cannot be paired`);
    }
    return { baseline: entry, candidate: other };
  });
};

const lossRateOf = (entry: ContextCaseReport): number => entry.lossSignals / entry.compactions;

const intervalOf = (differences: readonly number[], seed: number): BootstrapInterval | undefined => (differences.length === 0 ? undefined : pairedBootstrap(differences, { seed }));

const describeInterval = (interval: BootstrapInterval, digits: number): string =>
  `${interval.mean.toFixed(digits)} (95% bootstrap ${interval.low.toFixed(digits)}..${interval.high.toFixed(digits)}), n=${interval.n}`;

const NO_MEASURE = 'no measure';

const pairedCheck = (name: GateCheckName, pairCount: number, interval: BootstrapInterval | undefined, digits: number): GateCheck => {
  if (interval === undefined) return { name, passed: false, detail: `${NO_MEASURE}: no on case compacted in both reports` };
  const described = `paired difference ${describeInterval(interval, digits)}`;
  if (pairCount < MINIMUM_PAIRS) return { name, passed: false, detail: `too few pairs: ${pairCount} of the ${MINIMUM_PAIRS} needed for a real interval; ${described}` };
  return { name, passed: !(interval.low > 0), detail: `${described}; the candidate is worse only when the whole interval lies above 0` };
};

const passedRunsOf = (cases: readonly ContextCaseReport[]): number => cases.reduce((sum, entry) => sum + entry.passedRuns, 0);

const noWorseCount = (name: GateCheckName, what: string, baselineCount: number, candidateCount: number): GateCheck => ({
  name,
  passed: candidateCount >= baselineCount,
  detail: `${what}: candidate ${candidateCount}, baseline ${baselineCount}; the candidate must pass at least as many`,
});

const contrastiveCheck = (baseline: ContextReport, candidate: ContextReport): GateCheck => {
  const before = baseline.metrics.contrastiveFailures;
  const after = candidate.metrics.contrastiveFailures;
  const name = 'contrastiveFailures';
  if (before.n === 0 || after.n === 0) return { name, passed: false, detail: `${NO_MEASURE}: ${before.n === 0 ? 'baseline' : 'candidate'} has no scenario whose on case compacted` };
  if (before.n !== after.n) return { name, passed: false, detail: `the reports count over ${before.n} and ${after.n} compacted scenarios, so the counts do not compare` };
  return { name, passed: after.count < before.count, detail: `candidate ${after.count}, baseline ${before.count}, over ${before.n} scenarios; the candidate must have fewer` };
};

const fabricationCheck = (baseline: ClusteredProportion | undefined, candidate: ClusteredProportion | undefined): GateCheck => {
  const name = 'fabricationRate';
  if (baseline === undefined || candidate === undefined) {
    return { name, passed: false, detail: `${NO_MEASURE}: ${baseline === undefined ? 'baseline' : 'candidate'} holds no summary the model produced` };
  }
  return {
    name,
    passed: candidate.rate <= baseline.high,
    detail: `candidate ${percent(candidate.rate)} against the upper end ${percent(baseline.high)} of the baseline bootstrap interval over ${baseline.clusters} case(s)`,
  };
};

export const compareContextReports = (baseline: ContextReport, candidate: ContextReport, options: { seed: number }): ContextComparison => {
  const pairs = pairCases(baseline, candidate);
  const compacted = pairs.filter((pair) => pair.baseline.compaction === 'on' && pair.baseline.compactions > 0 && pair.candidate.compactions > 0);
  const loss = intervalOf(
    compacted.map((pair) => lossRateOf(pair.candidate) - lossRateOf(pair.baseline)),
    options.seed,
  );
  const tokens = intervalOf(
    compacted.map((pair) => pair.candidate.totalTokens - pair.baseline.totalTokens),
    options.seed,
  );
  const baselineFabrication = baseline.metrics.fabricationRate;
  const candidateFabrication = candidate.metrics.fabricationRate;
  const bothReal = baseline.model === 'real' && candidate.model === 'real';
  const offCases = (report: ContextReport) => report.cases.filter((entry) => entry.compaction === 'off');
  const unclassified = baseline.unclassifiedCompactions + candidate.unclassifiedCompactions;
  const checks: GateCheck[] = [
    {
      name: 'real_model',
      passed: bothReal,
      detail: `baseline model ${baseline.model}, candidate model ${candidate.model}, both declared by the operator${bothReal ? '' : '; a fake model proves only that the machinery works, so it cannot pass the gate'}`,
    },
    contrastiveCheck(baseline, candidate),
    fabricationCheck(baselineFabrication, candidateFabrication),
    pairedCheck('lossSignalsPerCompaction', compacted.length, loss, 3),
    pairedCheck('tokensPerSuccess', compacted.length, tokens, 1),
    noWorseCount('offCases', 'runs passed by the off cases', passedRunsOf(offCases(baseline)), passedRunsOf(offCases(candidate))),
    noWorseCount('overallPasses', 'runs passed overall', passedRunsOf(baseline.cases), passedRunsOf(candidate.cases)),
    {
      name: 'unclassifiedCompactions',
      passed: unclassified === 0,
      detail: `${baseline.unclassifiedCompactions} in the baseline and ${candidate.unclassifiedCompactions} in the candidate; a compaction with no source or fidelity lies outside the fabrication term`,
    },
  ];
  return {
    baseline: { dataset: baseline.dataset, model: baseline.model },
    candidate: { dataset: candidate.dataset, model: candidate.model },
    contrastiveFailures: { baseline: baseline.metrics.contrastiveFailures.count, candidate: candidate.metrics.contrastiveFailures.count, n: baseline.metrics.contrastiveFailures.n },
    fabricationRate: { baseline: baselineFabrication, candidate: candidateFabrication },
    differences: { lossSignalsPerCompaction: loss, tokensPerSuccess: tokens },
    gate: { passed: checks.every((check) => check.passed), checks },
  };
};

const describeDifference = (name: string, interval: BootstrapInterval | undefined, digits: number): string =>
  `${name} ${interval === undefined ? 'n/a (no pair)' : `paired difference ${describeInterval(interval, digits)}`}`;

const describeFabrication = (value: ClusteredProportion | undefined): string => (value === undefined ? 'n/a' : describeClustered(value));

export const formatContextComparison = (comparison: ContextComparison): string => {
  const lines = [
    `baseline: dataset ${comparison.baseline.dataset}, model ${comparison.baseline.model}`,
    `candidate: dataset ${comparison.candidate.dataset}, model ${comparison.candidate.model}`,
    `contrastiveFailures baseline ${comparison.contrastiveFailures.baseline}, candidate ${comparison.contrastiveFailures.candidate}, n=${comparison.contrastiveFailures.n}`,
    `fabricationRate baseline ${describeFabrication(comparison.fabricationRate.baseline)}, candidate ${describeFabrication(comparison.fabricationRate.candidate)}`,
    describeDifference('lossSignalsPerCompaction', comparison.differences.lossSignalsPerCompaction, 3),
    describeDifference('tokensPerSuccess', comparison.differences.tokensPerSuccess, 1),
    `gate: ${comparison.gate.passed ? 'PASS' : 'FAIL'}`,
  ];
  for (const check of comparison.gate.checks) lines.push(`  ${check.passed ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`);
  return lines.join('\n');
};
