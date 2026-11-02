import { pairedBootstrap } from './bootstrap.ts';
import type { BootstrapInterval } from './bootstrap.ts';
import type { ContextCaseReport, ContextReport } from './context-report.ts';
import { describeProportion, percent } from './report.ts';
import { EvalError } from './runner.ts';
import type { Proportion } from './stats.ts';

export const GATE_CHECKS = ['real_model', 'contrastiveFailures', 'fabricationRate', 'lossSignalsPerCompaction', 'tokensPerSuccess'] as const;
export type GateCheckName = (typeof GATE_CHECKS)[number];

export type GateCheck = { name: GateCheckName; passed: boolean; detail: string };

export type ContextComparison = {
  baseline: { dataset: string; model: ContextReport['model'] };
  candidate: { dataset: string; model: ContextReport['model'] };
  contrastiveFailures: { baseline: number; candidate: number; n: number };
  fabricationRate: { baseline: Proportion | undefined; candidate: Proportion | undefined };
  differences: { lossSignalsPerCompaction: BootstrapInterval | undefined; tokensPerSuccess: BootstrapInterval | undefined };
  gate: { passed: boolean; checks: GateCheck[] };
};

type CasePair = { baseline: ContextCaseReport; candidate: ContextCaseReport };

const pairCases = (baseline: ContextReport, candidate: ContextReport): CasePair[] => {
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

const noWorseCheck = (name: GateCheckName, interval: BootstrapInterval | undefined, digits: number, absence: string): GateCheck => {
  if (interval === undefined) return { name, passed: true, detail: `${absence}; nothing to compare` };
  return { name, passed: !(interval.low > 0), detail: `paired difference ${describeInterval(interval, digits)}; the candidate is worse only when the whole interval lies above 0` };
};

export const compareContextReports = (baseline: ContextReport, candidate: ContextReport, options: { seed: number }): ContextComparison => {
  const pairs = pairCases(baseline, candidate);
  const loss = intervalOf(
    pairs.filter((pair) => pair.baseline.compactions > 0 && pair.candidate.compactions > 0).map((pair) => lossRateOf(pair.candidate) - lossRateOf(pair.baseline)),
    options.seed,
  );
  const tokens = intervalOf(
    pairs.filter((pair) => pair.baseline.passed && pair.candidate.passed).map((pair) => pair.candidate.totalTokens - pair.baseline.totalTokens),
    options.seed,
  );
  const baselineFabrication = baseline.metrics.fabricationRate;
  const candidateFabrication = candidate.metrics.fabricationRate;
  const bothReal = baseline.model === 'real' && candidate.model === 'real';
  const fabricationWithinBaseline = baselineFabrication === undefined || candidateFabrication === undefined || candidateFabrication.rate <= baselineFabrication.high;
  const checks: GateCheck[] = [
    {
      name: 'real_model',
      passed: bothReal,
      detail: `baseline model ${baseline.model}, candidate model ${candidate.model}${bothReal ? '' : '; a fake model proves only that the machinery works, so it cannot pass the gate'}`,
    },
    {
      name: 'contrastiveFailures',
      passed: candidate.metrics.contrastiveFailures.count < baseline.metrics.contrastiveFailures.count,
      detail: `candidate ${candidate.metrics.contrastiveFailures.count}, baseline ${baseline.metrics.contrastiveFailures.count}; the candidate must have fewer`,
    },
    {
      name: 'fabricationRate',
      passed: fabricationWithinBaseline,
      detail:
        baselineFabrication === undefined || candidateFabrication === undefined
          ? 'a report holds no model summary; nothing to compare'
          : `candidate ${percent(candidateFabrication.rate)} against the baseline Wilson upper bound ${percent(baselineFabrication.high)}`,
    },
    noWorseCheck('lossSignalsPerCompaction', loss, 3, 'no case compacted in both reports'),
    noWorseCheck('tokensPerSuccess', tokens, 1, 'no case passed in both reports'),
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

const describeFabrication = (value: Proportion | undefined): string => (value === undefined ? 'n/a' : describeProportion(value));

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
