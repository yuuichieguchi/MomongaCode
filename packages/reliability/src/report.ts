import { INDICATOR_DEFINITIONS_VERSION, MIN_RATE_POPULATION, RELIABILITY_FORMAT } from '@momonga/protocol';
import { indicatorsOf } from './aggregate.ts';
import type { Aggregate } from './aggregate.ts';
import type { GroupKey, Indicators, Rate } from './types.ts';
import { wilsonInterval } from './wilson.ts';

export const REPORT_KINDS = ['real', 'benchmark', 'injection'] as const;

export type ReportKind = (typeof REPORT_KINDS)[number];

export type ReliabilityReport = {
  format: typeof RELIABILITY_FORMAT;
  kind: ReportKind;
  definitionsVersion: number;
  groupBy: GroupKey;
  total: Indicators;
  groups: Record<string, Indicators>;
};

export type ReportInput = { kind: ReportKind; aggregate: Aggregate };

export const buildReliabilityReport = ({ kind, aggregate }: ReportInput): ReliabilityReport => {
  const { total, groups } = indicatorsOf(aggregate);
  return { format: RELIABILITY_FORMAT, kind, definitionsVersion: INDICATOR_DEFINITIONS_VERSION, groupBy: aggregate.groupBy, total, groups };
};

const percent = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`;

export const describeRate = ({ k, n }: Rate): string => {
  if (n < MIN_RATE_POPULATION) return `${k}/${n}`;
  const { low, high } = wilsonInterval(k, n);
  return `${k}/${n} = ${percent(k / n)} (95% Wilson ${percent(low)}..${percent(high)})`;
};

const milliseconds = (value: number | null): string => (value === null ? 'n/a' : `${value} ms`);

const indicatorLines = (indicators: Indicators): string[] => {
  const { completion, recovery, recoveryTime, duplicates, intervention, overrun, time } = indicators;
  return [
    completion.n === 0
      ? `Task Completion Rate: not measurable: no task declared a completion condition (${completion.undeclared} tasks without one)`
      : `Task Completion Rate: ${describeRate(completion)} (${completion.undeclared} tasks without a declared condition are not in the denominator)`,
    `Recovery Success Rate: ${describeRate(recovery)}; unknown_effect ${recovery.unknownEffect}; failed ${recovery.failed}; stopped ${recovery.stopped}`,
    `Mean Recovery Time: n=${recoveryTime.n}, mean ${milliseconds(recoveryTime.meanMs)}, median ${milliseconds(recoveryTime.medianMs)}; clock_skew ${recoveryTime.clockSkew}`,
    `Duplicate Side Effect Rate (journal): ${describeRate(duplicates.journal)}; prevented ${duplicates.prevented}; unknown ${duplicates.unknown}`,
    `Human Intervention Rate: ${describeRate(intervention)}`,
    `Budget Overrun Rate: ${describeRate(overrun)}; budget stops ${overrun.budgetStops}`,
    `Time per Successful Task: n=${time.n}, active mean ${milliseconds(time.meanActiveMs)}, elapsed mean ${milliseconds(time.meanElapsedMs)}`,
  ];
};

const populationLine = ({ buckets }: Indicators): string => {
  const roots = buckets.counted + buckets.cancelled + buckets.pendingFacts;
  return `Population: ${roots} terminal root tasks; counted ${buckets.counted}; cancelled ${buckets.cancelled} (excluded); pending facts ${buckets.pendingFacts} (excluded); facts coverage ${buckets.counted + buckets.cancelled}/${roots}`;
};

export const formatReliabilityReport = (report: ReliabilityReport): string => {
  const lines = [
    `Reliability report (${report.format}), kind ${report.kind}, definitions version ${report.definitionsVersion}, grouped by ${report.groupBy}`,
    populationLine(report.total),
    ...indicatorLines(report.total),
  ];
  for (const [name, indicators] of Object.entries(report.groups)) {
    lines.push('', `[${report.groupBy}=${name}]`, populationLine(indicators), ...indicatorLines(indicators));
  }
  return `${lines.join('\n')}\n`;
};
