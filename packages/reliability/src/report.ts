import { INDICATOR_DEFINITIONS_VERSION, MIN_RATE_POPULATION, RELIABILITY_FORMAT, escapeTerminalLine, modelKindOf } from '@momonga/protocol';
import type { AnsweredByView } from '@momonga/protocol';
import { indicatorsOf } from './aggregate.ts';
import type { Aggregate, Period } from './aggregate.ts';
import { costLines } from './cost.ts';
import type { CostGroups, CostIndicators } from './cost.ts';
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
  period?: Period;
  cost?: CostGroups;
};

type Measured = { aggregate: Aggregate };

export type ReportInput =
  | (Measured & { kind: 'real'; harness?: null; period?: Period; cost?: CostGroups })
  | (Measured & { kind: 'benchmark'; harness: Harness; tasks?: TaskRow[]; cost: CostGroups })
  | (Measured & { kind: 'injection'; harness: Harness; scenarios?: ScenarioRow[]; witnessed?: Rate; notRun?: NotRun[] });

export const buildReliabilityReport = (input: ReportInput): ReliabilityReport => {
  const { total, groups } = indicatorsOf(input.aggregate);
  const base: Omit<ReliabilityReport, 'kind' | 'harness'> = { format: RELIABILITY_FORMAT, definitionsVersion: INDICATOR_DEFINITIONS_VERSION, groupBy: input.aggregate.groupBy, total, groups };
  switch (input.kind) {
    case 'real':
      return { ...base, kind: 'real', harness: null, ...(input.period === undefined ? {} : { period: input.period }), ...(input.cost === undefined ? {} : { cost: input.cost }) };
    case 'benchmark':
      return { ...base, kind: 'benchmark', harness: input.harness, ...(input.tasks === undefined ? {} : { tasks: input.tasks }), cost: input.cost };
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

const indicatorLines = (indicators: Indicators, cost?: CostIndicators): string[] => {
  const { completion, recovery, recoveryTime, duplicates, intervention, overrun, delegation, time } = indicators;
  return [
    completion.n === 0
      ? `Task Completion Rate: not measurable: no task declared a completion condition (${completion.undeclared} tasks without one)`
      : `Task Completion Rate: ${describeRate(completion)} (${completion.undeclared} tasks without a declared condition are not in the denominator)`,
    `Recovery Success Rate: ${describeRate(recovery)}; unknown_effect ${recovery.unknownEffect}; failed ${recovery.failed}; stopped ${recovery.stopped}`,
    `Mean Recovery Time: n=${recoveryTime.n}, mean ${milliseconds(recoveryTime.meanMs)}, median ${milliseconds(recoveryTime.medianMs)}; clock_skew ${recoveryTime.clockSkew}`,
    `Duplicate Side Effect Rate (journal): ${describeRate(duplicates.journal)}; prevented ${duplicates.prevented}; unknown ${duplicates.unknown}`,
    `Human Intervention Rate: ${describeRate(intervention)}`,
    `Budget Overrun Rate: ${describeRate(overrun)}; over the money limit ${describeRate(overrun.money)}; budget stops ${overrun.budgetStops}`,
    `Delegation (mandate runs): n=${delegation.n}; a person resolved a held call in ${describeRate({ k: delegation.intervened, n: delegation.n })}; completed with no held call ${describeRate({ k: delegation.unattended, n: delegation.n })}; waited for a person at least once ${delegation.waited}; held calls ${delegation.held}; denied outside the mandate ${delegation.denied}`,
    `Time per Successful Task: n=${time.n}, active mean ${milliseconds(time.meanActiveMs)}, elapsed mean ${milliseconds(time.meanElapsedMs)}`,
    ...(cost === undefined ? [] : costLines(cost)),
  ];
};

const populationLine = ({ buckets }: Indicators): string => {
  const roots = buckets.counted + buckets.cancelled + buckets.pendingFacts + buckets.factsUnavailable + buckets.unknownValues;
  return `Population: ${roots} terminal root tasks; counted ${buckets.counted}; cancelled ${buckets.cancelled} (excluded); pending facts ${buckets.pendingFacts} (excluded); facts unavailable ${buckets.factsUnavailable} (excluded); unknown values ${buckets.unknownValues} (excluded); facts coverage ${buckets.counted + buckets.cancelled + buckets.factsUnavailable + buckets.unknownValues}/${roots}`;
};

const periodLines = (period: Period | undefined): string[] =>
  period === undefined ? [] : [`Period: tasks whose root run ended in the last ${period.days} ${period.days === 1 ? 'day' : 'days'} (${new Date(period.fromMs).toISOString()} to ${new Date(period.toMs).toISOString()})`];

const harnessLines = (harness: Harness | null): string[] =>
  harness === null
    ? []
    : [
        `Suite: ${escapeTerminalLine(harness.suite.name)} (${harness.suite.digest}); code ${harness.codeDigest}`,
        `Answered by: ${harness.answeredBy.map((answerer) => `${escapeTerminalLine(answerer.target)} (${answerer.answers})`).join(', ') || 'nobody recorded'}; unrecorded ${harness.unrecordedAnswers}; model kind ${modelKindOf(harness.answeredBy, harness.unrecordedAnswers)}`,
      ];

const rowLines = (report: ReliabilityReport): string[] => [
  ...(report.population?.notRun ?? []).map((entry) => `Not run: ${escapeTerminalLine(entry.id)}: ${escapeTerminalLine(entry.reason)}`),
  ...(report.tasks ?? []).map((row) => `Task ${escapeTerminalLine(row.task)} (${escapeTerminalLine(row.taskType)}, ${escapeTerminalLine(row.difficulty)}): met ${row.met}/${row.trials}`),
  ...(report.scenarios ?? []).map((row) => `Scenario ${escapeTerminalLine(row.scenario)}: recovered ${row.recovered}/${row.episodes} episodes in ${row.trials} trials`),
  ...(report.witnessed === undefined ? [] : [`Duplicate Side Effect Rate (witnessed): ${describeRate(report.witnessed)}`]),
];

export const formatReliabilityReport = (report: ReliabilityReport): string => {
  const lines = [
    `Reliability report (${report.format}), kind ${report.kind}, definitions version ${report.definitionsVersion}, grouped by ${report.groupBy}`,
    ...harnessLines(report.harness),
    ...periodLines(report.period),
    populationLine(report.total),
    ...indicatorLines(report.total, report.cost?.total),
  ];
  for (const [name, indicators] of Object.entries(report.groups)) {
    lines.push('', `[${report.groupBy}=${escapeTerminalLine(name)}]`, populationLine(indicators), ...indicatorLines(indicators, report.cost?.groups[name]));
  }
  const rows = rowLines(report);
  if (rows.length > 0) lines.push('', ...rows);
  return `${lines.join('\n')}\n`;
};
