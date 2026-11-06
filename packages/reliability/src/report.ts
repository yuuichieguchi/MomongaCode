import { INDICATOR_DEFINITIONS_VERSION, MIN_RATE_POPULATION, RELIABILITY_FORMAT, modelKindOf } from '@momonga/protocol';
import type { AnsweredByView } from '@momonga/protocol';
import { indicatorsOf } from './aggregate.ts';
import type { Aggregate } from './aggregate.ts';
import type { GroupKey, Indicators, Rate } from './types.ts';
import { wilsonInterval } from './wilson.ts';

export const REPORT_KINDS = ['real', 'benchmark', 'injection'] as const;

export type ReportKind = (typeof REPORT_KINDS)[number];

export type Harness = {
  suite: { name: string; digest: string };
  answeredBy: AnsweredByView[];
  unrecordedAnswers: number;
  codeDigest: string;
};

export type TaskRow = { task: string; trials: number; met: number; difficulty: string; taskType: string };

export type ScenarioRow = { scenario: string; trials: number; episodes: number; recovered: number };

export type NotRun = { id: string; reason: string };

export type ReliabilityReport = {
  format: typeof RELIABILITY_FORMAT;
  kind: ReportKind;
  definitionsVersion: number;
  groupBy: GroupKey;
  total: Indicators;
  groups: Record<string, Indicators>;
  harness: Harness | null;
  tasks?: TaskRow[];
  scenarios?: ScenarioRow[];
  witnessed?: Rate;
  population?: { notRun: NotRun[] };
};

type Measured = { aggregate: Aggregate };

export type ReportInput =
  | (Measured & { kind: 'real'; harness?: null })
  | (Measured & { kind: 'benchmark'; harness: Harness; tasks?: TaskRow[] })
  | (Measured & { kind: 'injection'; harness: Harness; scenarios?: ScenarioRow[]; witnessed?: Rate; notRun?: NotRun[] });

export const buildReliabilityReport = (input: ReportInput): ReliabilityReport => {
  const { total, groups } = indicatorsOf(input.aggregate);
  const base: Omit<ReliabilityReport, 'kind' | 'harness'> = { format: RELIABILITY_FORMAT, definitionsVersion: INDICATOR_DEFINITIONS_VERSION, groupBy: input.aggregate.groupBy, total, groups };
  switch (input.kind) {
    case 'real':
      return { ...base, kind: 'real', harness: null };
    case 'benchmark':
      return { ...base, kind: 'benchmark', harness: input.harness, ...(input.tasks === undefined ? {} : { tasks: input.tasks }) };
    case 'injection':
      return {
        ...base,
        kind: 'injection',
        harness: input.harness,
        ...(input.scenarios === undefined ? {} : { scenarios: input.scenarios }),
        ...(input.witnessed === undefined ? {} : { witnessed: input.witnessed }),
        ...(input.notRun === undefined ? {} : { population: { notRun: input.notRun } }),
      };
  }
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

const harnessLines = (harness: Harness | null): string[] =>
  harness === null
    ? []
    : [
        `Suite: ${harness.suite.name} (${harness.suite.digest}); code ${harness.codeDigest}`,
        `Answered by: ${harness.answeredBy.map((answerer) => `${answerer.target} (${answerer.answers})`).join(', ') || 'nobody recorded'}; unrecorded ${harness.unrecordedAnswers}; model kind ${modelKindOf(harness.answeredBy, harness.unrecordedAnswers)}`,
      ];

const rowLines = (report: ReliabilityReport): string[] => [
  ...(report.population?.notRun ?? []).map((entry) => `Not run: ${entry.id}: ${entry.reason}`),
  ...(report.tasks ?? []).map((row) => `Task ${row.task} (${row.taskType}, ${row.difficulty}): met ${row.met}/${row.trials}`),
  ...(report.scenarios ?? []).map((row) => `Scenario ${row.scenario}: recovered ${row.recovered}/${row.episodes} episodes in ${row.trials} trials`),
  ...(report.witnessed === undefined ? [] : [`Duplicate Side Effect Rate (witnessed): ${describeRate(report.witnessed)}`]),
];

export const formatReliabilityReport = (report: ReliabilityReport): string => {
  const lines = [
    `Reliability report (${report.format}), kind ${report.kind}, definitions version ${report.definitionsVersion}, grouped by ${report.groupBy}`,
    ...harnessLines(report.harness),
    populationLine(report.total),
    ...indicatorLines(report.total),
  ];
  for (const [name, indicators] of Object.entries(report.groups)) {
    lines.push('', `[${report.groupBy}=${name}]`, populationLine(indicators), ...indicatorLines(indicators));
  }
  const rows = rowLines(report);
  if (rows.length > 0) lines.push('', ...rows);
  return `${lines.join('\n')}\n`;
};
