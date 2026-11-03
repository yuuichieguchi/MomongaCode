import { MINIMUM_PAIRS, pairedBootstrap, pairedRatioBootstrap } from './bootstrap.ts';
import type { BootstrapInterval, Cluster } from './bootstrap.ts';
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

export const GATE_NAMES = ['context', 'token'] as const;
export type GateName = (typeof GATE_NAMES)[number];

export const TOKEN_PRIMARY_METRICS = ['costPerSuccess', 'uncachedInputPerSuccess'] as const;
export type TokenPrimaryMetric = (typeof TOKEN_PRIMARY_METRICS)[number];

export type GateCheckName = (typeof GATE_CHECKS)[number] | 'passRate' | TokenPrimaryMetric;

export type GateCheck = { name: GateCheckName; passed: boolean; detail: string };

export type ContextComparison = {
  gateName: GateName;
  baseline: { dataset: string; model: ContextReport['model'] };
  candidate: { dataset: string; model: ContextReport['model'] };
  contrastiveFailures: { baseline: number; candidate: number; n: number };
  fabricationRate: { baseline: ClusteredProportion | undefined; candidate: ClusteredProportion | undefined };
  differences: {
    lossSignalsPerCompaction: BootstrapInterval | undefined;
    tokensPerSuccess: BootstrapInterval | undefined;
    passRate?: BootstrapInterval | undefined;
    primary?: { metric: TokenPrimaryMetric; interval: BootstrapInterval | undefined };
  };
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

type Terms = {
  baseline: ContextReport;
  candidate: ContextReport;
  pairs: CasePair[];
  compacted: CasePair[];
  loss: BootstrapInterval | undefined;
  tokens: BootstrapInterval | undefined;
  passRate: BootstrapInterval | undefined;
  primary: { metric: TokenPrimaryMetric; interval: BootstrapInterval | undefined; why: string | undefined };
};

type Term = (terms: Terms) => GateCheck;

const realModelTerm: Term = ({ baseline, candidate }) => {
  const bothReal = baseline.model === 'real' && candidate.model === 'real';
  return {
    name: 'real_model',
    passed: bothReal,
    detail: `baseline model ${baseline.model}, candidate model ${candidate.model}, both declared by the operator${bothReal ? '' : '; a fake model proves only that the machinery works, so it cannot pass the gate'}`,
  };
};

const lossTerm: Term = ({ compacted, loss }) => pairedCheck('lossSignalsPerCompaction', compacted.length, loss, 3);

const fabricationTerm: Term = ({ baseline, candidate }) => fabricationCheck(baseline.metrics.fabricationRate, candidate.metrics.fabricationRate);

const contrastiveTerm: Term = ({ baseline, candidate }) => contrastiveCheck(baseline, candidate);

const tokensTerm: Term = ({ compacted, tokens }) => pairedCheck('tokensPerSuccess', compacted.length, tokens, 1);

const offCasesTerm: Term = ({ baseline, candidate }) => {
  const offCases = (report: ContextReport) => report.cases.filter((entry) => entry.compaction === 'off');
  return noWorseCount('offCases', 'runs passed by the off cases', passedRunsOf(offCases(baseline)), passedRunsOf(offCases(candidate)));
};

const overallTerm: Term = ({ baseline, candidate }) => noWorseCount('overallPasses', 'runs passed overall', passedRunsOf(baseline.cases), passedRunsOf(candidate.cases));

const unclassifiedTerm: Term = ({ baseline, candidate }) => ({
  name: 'unclassifiedCompactions',
  passed: baseline.unclassifiedCompactions + candidate.unclassifiedCompactions === 0,
  detail: `${baseline.unclassifiedCompactions} in the baseline and ${candidate.unclassifiedCompactions} in the candidate; a compaction with no source or fidelity lies outside the fabrication term`,
});

const passRateTerm: Term = ({ pairs, passRate }) => {
  const name = 'passRate';
  if (passRate === undefined) return { name, passed: false, detail: `${NO_MEASURE}: no case is recorded in both reports` };
  const described = `paired difference ${describeInterval(passRate, 3)}`;
  if (pairs.length < MINIMUM_PAIRS) return { name, passed: false, detail: `too few pairs: ${pairs.length} of the ${MINIMUM_PAIRS} needed for a real interval; ${described}` };
  return { name, passed: !(passRate.high < 0), detail: `${described}; the candidate is worse only when the whole interval lies below 0` };
};

const primaryTerm: Term = ({ pairs, primary }) => {
  const { metric, interval, why } = primary;
  const reason = why === undefined ? '' : `; judged on uncached input because ${why}`;
  if (interval === undefined) {
    return { name: metric, passed: false, detail: `${NO_MEASURE}: ${metric} is not recorded for every case of both reports${why === undefined ? '' : `; ${why}`}` };
  }
  const described = `paired difference per success ${describeInterval(interval, metric === 'costPerSuccess' ? 6 : 1)}`;
  if (pairs.length < MINIMUM_PAIRS) {
    return { name: metric, passed: false, detail: `too few pairs: ${pairs.length} of the ${MINIMUM_PAIRS} needed for a real interval; ${described}${reason}` };
  }
  return {
    name: metric,
    passed: interval.high < 0,
    detail: `${described}; the candidate must be lower, the whole interval below 0; resamples with no success in either report are skipped, so the ${MINIMUM_PAIRS}-pair tail holds only while few are skipped${reason}`,
  };
};

const GATE_TERMS: Record<GateName, readonly Term[]> = {
  context: [realModelTerm, contrastiveTerm, fabricationTerm, lossTerm, tokensTerm, offCasesTerm, overallTerm, unclassifiedTerm],
  token: [realModelTerm, passRateTerm, primaryTerm, lossTerm, fabricationTerm],
};

const sideNames = ['baseline', 'candidate'] as const;

const tokenPrimaryOf = (baseline: ContextReport, candidate: ContextReport, pairs: readonly CasePair[], seed: number): Terms['primary'] => {
  const reports = { baseline, candidate };
  const costMissing = sideNames.flatMap((side) => (reports[side].metrics.costPerSuccess === undefined ? [side] : []));
  const costFree = sideNames.flatMap((side) => (reports[side].metrics.costPerSuccess?.numerator === 0 ? [side] : []));
  const metric: TokenPrimaryMetric = costMissing.length === 0 && costFree.length === 0 ? 'costPerSuccess' : 'uncachedInputPerSuccess';
  const why =
    metric === 'costPerSuccess'
      ? undefined
      : costMissing.length > 0
        ? `cost per success is not measured in the ${costMissing.join(' and the ')} (a call carries no price, or no run succeeded)`
        : `the total cost of the ${costFree.join(' and the ')} is 0, which a cost per success cannot rank`;
  const clusters = pairs.map((pair) => {
    const pick = (entry: ContextCaseReport): Cluster | undefined => {
      const totals = entry.tokens;
      const numerator = metric === 'costPerSuccess' ? totals?.cost : totals?.uncachedInputTokens;
      return numerator === undefined ? undefined : { numerator, denominator: entry.passedRuns };
    };
    return { baseline: pick(pair.baseline), candidate: pick(pair.candidate) };
  });
  const complete = clusters.flatMap((pair) => (pair.baseline === undefined || pair.candidate === undefined ? [] : [{ baseline: pair.baseline, candidate: pair.candidate }]));
  const measured = complete.length === clusters.length && baseline.metrics[metric] !== undefined && candidate.metrics[metric] !== undefined;
  const unsettled = pairs.reduce((sum, pair) => sum + (pair.baseline.tokens?.unsettledReflections ?? 0) + (pair.candidate.tokens?.unsettledReflections ?? 0), 0);
  const reflectionNote = unsettled === 0 ? undefined : `${unsettled} run(s) have a reflection that is pending, running past its bound or not recorded, so their token cost is not final`;
  return { metric, interval: measured ? pairedRatioBootstrap(complete, { seed }) : undefined, why: [why, reflectionNote].filter((part) => part !== undefined).join('; ') || undefined };
};

export const compareContextReports = (
  baseline: ContextReport,
  candidate: ContextReport,
  options: { seed: number; gate?: GateName },
): ContextComparison => {
  const gateName = options.gate ?? 'context';
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
  const passRate = intervalOf(
    pairs.map((pair) => pair.candidate.passRate.rate - pair.baseline.passRate.rate),
    options.seed,
  );
  const primary = tokenPrimaryOf(baseline, candidate, pairs, options.seed);
  const terms: Terms = { baseline, candidate, pairs, compacted, loss, tokens, passRate, primary };
  const checks = GATE_TERMS[gateName].map((term) => term(terms));
  return {
    gateName,
    baseline: { dataset: baseline.dataset, model: baseline.model },
    candidate: { dataset: candidate.dataset, model: candidate.model },
    contrastiveFailures: { baseline: baseline.metrics.contrastiveFailures.count, candidate: candidate.metrics.contrastiveFailures.count, n: baseline.metrics.contrastiveFailures.n },
    fabricationRate: { baseline: baseline.metrics.fabricationRate, candidate: candidate.metrics.fabricationRate },
    differences: {
      lossSignalsPerCompaction: loss,
      tokensPerSuccess: tokens,
      ...(gateName === 'token' ? { passRate, primary: { metric: primary.metric, interval: primary.interval } } : {}),
    },
    gate: { passed: checks.every((check) => check.passed), checks },
  };
};

const describeDifference = (name: string, interval: BootstrapInterval | undefined, digits: number): string =>
  `${name} ${interval === undefined ? 'n/a (no pair)' : `paired difference ${describeInterval(interval, digits)}`}`;

const describeFabrication = (value: ClusteredProportion | undefined): string => (value === undefined ? 'n/a' : describeClustered(value));

const gateLines = (comparison: ContextComparison): string[] => [
  `gate: ${comparison.gate.passed ? 'PASS' : 'FAIL'}`,
  ...comparison.gate.checks.map((check) => `  ${check.passed ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`),
];

export const formatContextComparison = (comparison: ContextComparison): string => {
  const heading = [
    `baseline: dataset ${comparison.baseline.dataset}, model ${comparison.baseline.model}`,
    `candidate: dataset ${comparison.candidate.dataset}, model ${comparison.candidate.model}`,
  ];
  if (comparison.gateName === 'token') {
    const { primary } = comparison.differences;
    return [
      ...heading,
      describeDifference('passRate', comparison.differences.passRate, 3),
      primary === undefined ? 'primary n/a' : describeDifference(primary.metric, primary.interval, primary.metric === 'costPerSuccess' ? 6 : 1),
      describeDifference('lossSignalsPerCompaction', comparison.differences.lossSignalsPerCompaction, 3),
      `fabricationRate baseline ${describeFabrication(comparison.fabricationRate.baseline)}, candidate ${describeFabrication(comparison.fabricationRate.candidate)}`,
      ...gateLines(comparison),
    ].join('\n');
  }
  return [
    ...heading,
    `contrastiveFailures baseline ${comparison.contrastiveFailures.baseline}, candidate ${comparison.contrastiveFailures.candidate}, n=${comparison.contrastiveFailures.n}`,
    `fabricationRate baseline ${describeFabrication(comparison.fabricationRate.baseline)}, candidate ${describeFabrication(comparison.fabricationRate.candidate)}`,
    describeDifference('lossSignalsPerCompaction', comparison.differences.lossSignalsPerCompaction, 3),
    describeDifference('tokensPerSuccess', comparison.differences.tokensPerSuccess, 1),
    ...gateLines(comparison),
  ].join('\n');
};
