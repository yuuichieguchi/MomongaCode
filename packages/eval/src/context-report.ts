import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { clusterBootstrap } from './bootstrap.ts';
import type { Cluster } from './bootstrap.ts';
import { COMPACTION_SETTINGS, expandContextDataset } from './context-dataset.ts';
import type { CompactionSetting, ContextDataset, ExpandedCase } from './context-dataset.ts';
import { compactionFactsOf, governanceCountsOf, lossSignalsOf, recalledOf, retrievalOf } from './context-metrics.ts';
import type { CompactionFacts, GovernanceCounts, Recalled, Retrieval } from './context-metrics.ts';
import { describeFirstError, jsonOf } from './dataset.ts';
import { grade } from './graders.ts';
import { describeProportion, percent, proportionOrUndefined } from './report.ts';
import { EvalError, transcriptsByCase } from './runner.ts';
import type { Proportion } from './stats.ts';
import { caseTotalsOf, tokenFactsOf, tokenMetricsOf } from './token-metrics.ts';
import type { CaseTokenTotals, RatioMetric, TokenFacts } from './token-metrics.ts';
import type { Transcript } from './transcript.ts';

export const CONTEXT_REPORT_FORMAT = 'momonga-eval-context-report/1';

export const CONTEXT_MODELS = ['fake', 'real'] as const;
export type ContextModel = (typeof CONTEXT_MODELS)[number];

export const MODEL_DEPENDENT_METRICS = [
  'cacheHitRatio',
  'callsPerSuccess',
  'continuationRate',
  'contrastiveFailures',
  'costPerSuccess',
  'fabricationRate',
  'identifierRetention',
  'latencyPerSuccess',
  'lossSignalsPerCompaction',
  'retrievalPrecision',
  'retrievalRecall',
  'tokensPerSuccess',
  'uncachedInputPerSuccess',
] as const;
export type ModelDependentMetric = (typeof MODEL_DEPENDENT_METRICS)[number];

export type ContextCaseReport = {
  id: string;
  scenario: string;
  compaction: CompactionSetting;
  runs: number;
  passedRuns: number;
  passed: boolean;
  passRate: Proportion;
  minPassRate: number;
  meetsMinimum: boolean;
  totalTokens: number;
  compactions: number;
  lossSignals: number;
  tokens?: CaseTokenTotals;
};

export type ClusteredProportion = Proportion & { clusters: number };

export type ContextMetrics = {
  continuationRate: Proportion | undefined;
  contrastiveFailures: { count: number; n: number };
  lossSignalsPerCompaction: { value: number; signals: number; compactions: number; n: number } | undefined;
  fabricationRate: ClusteredProportion | undefined;
  identifierRetention: ClusteredProportion | undefined;
  governanceFidelity: ClusteredProportion | undefined;
  governanceConsistency: Proportion | undefined;
  governanceMinimality: ClusteredProportion | undefined;
  memoryStaleRate: ClusteredProportion | undefined;
  retrievalPrecision: ClusteredProportion | undefined;
  retrievalRecall: ClusteredProportion | undefined;
  tokensPerSuccess: { value: number; tokens: number; successes: number; n: number } | undefined;
  costPerSuccess?: RatioMetric;
  uncachedInputPerSuccess?: RatioMetric;
  callsPerSuccess?: RatioMetric;
  latencyPerSuccess?: RatioMetric;
  cacheHitRatio?: RatioMetric;
  layerShares?: Record<string, RatioMetric>;
};

export const DEFAULT_DATASET_SEED = 0;

export const MAX_DATASET_SEED = 0xffffffff;

export type StoppedRun = { caseId: string; runIndex: number; reason: string };

export type ContextReport = {
  format: typeof CONTEXT_REPORT_FORMAT;
  dataset: string;
  datasetDigest: string;
  datasetSeed: number;
  model: ContextModel;
  modelAliases: string[];
  metrics: ContextMetrics;
  meaningless: ModelDependentMetric[];
  unclassifiedCompactions: number;
  governanceRunsWithoutEvent: number;
  noiseTokens: number;
  stopped: StoppedRun[];
  cases: ContextCaseReport[];
  passed: boolean;
};

type RunMeasure = {
  passed: boolean;
  tokens: number;
  facts: CompactionFacts;
  signals: number;
  governance: GovernanceCounts | undefined;
  recalled: Recalled;
  retrieval: Retrieval | undefined;
  modelAlias: string | undefined;
  token: TokenFacts;
};

const total = <T>(items: readonly T[], pick: (item: T) => number): number => items.reduce((sum, item) => sum + pick(item), 0);

const sumFacts = (list: readonly CompactionFacts[]): CompactionFacts => ({
  compactions: total(list, (facts) => facts.compactions),
  modelSummaries: total(list, (facts) => facts.modelSummaries),
  fabricatedSummaries: total(list, (facts) => facts.fabricatedSummaries),
  identifiers: total(list, (facts) => facts.identifiers),
  retained: total(list, (facts) => facts.retained),
  unclassified: total(list, (facts) => facts.unclassified),
});

const lastSeqOf = (events: Transcript['events']): number => events.reduce((last, event) => ('seq' in event ? Math.max(last, event.seq) : last), 0);

const measureRun = (entry: ExpandedCase, transcript: Transcript): RunMeasure => {
  const runs = [transcript.events, ...transcript.children.map((child) => child.events)];
  const facts = sumFacts(runs.map((events) => compactionFactsOf(events)));
  if (entry.compaction === 'off' && facts.compactions > 0) {
    throw new EvalError(`case ${entry.id} has compaction off but its run ${transcript.run.id} holds ${facts.compactions} compaction(s), so the pair would compare nothing`);
  }
  const stopped = transcript.stopped !== undefined;
  const beyond = stopped ? undefined : (entry.gold ?? []).find((range) => range.seqTo > lastSeqOf(transcript.events));
  if (beyond !== undefined) {
    throw new EvalError(`case ${entry.id} has the gold range ${beyond.seqFrom}..${beyond.seqTo} but run ${transcript.run.id} ends at seq ${lastSeqOf(transcript.events)}`);
  }
  return {
    passed: !stopped && grade(entry.graders, transcript).passed,
    tokens: transcript.run.usage.totalTokens,
    facts,
    signals: total(runs, (events) => lossSignalsOf(events).length),
    governance: governanceCountsOf(entry.rules, transcript.events, transcript.ruleIds),
    recalled: recalledOf(transcript.events),
    retrieval: entry.gold === undefined || stopped ? undefined : retrievalOf(entry.gold, transcript.events),
    modelAlias: transcript.run.modelAlias,
    token: tokenFactsOf(runs),
  };
};

const caseReportOf = (entry: ExpandedCase, measures: readonly RunMeasure[]): ContextCaseReport => {
  const passedRuns = measures.filter((measure) => measure.passed).length;
  const passRate = proportionOrUndefined(passedRuns, measures.length);
  if (passRate === undefined) throw new EvalError(`case ${entry.id} has no recorded run`);
  return {
    id: entry.id,
    scenario: entry.scenario,
    compaction: entry.compaction,
    runs: measures.length,
    passedRuns,
    passed: passedRuns === measures.length,
    passRate,
    minPassRate: entry.minPassRate,
    meetsMinimum: passRate.rate >= entry.minPassRate,
    totalTokens: total(measures, (measure) => measure.tokens),
    compactions: total(measures, (measure) => measure.facts.compactions),
    lossSignals: total(measures, (measure) => measure.signals),
    tokens: caseTotalsOf(measures.map((measure) => measure.token)),
  };
};

export type ContrastiveCase = { scenario: string; onId: string; offId: string };

const contrastiveCasesOfCases = (cases: readonly ContextCaseReport[]): ContrastiveCase[] => {
  const scenarios = [...new Set(cases.map((entry) => entry.scenario))];
  return scenarios.flatMap((scenario) => {
    const on = cases.find((entry) => entry.scenario === scenario && entry.compaction === 'on');
    const off = cases.find((entry) => entry.scenario === scenario && entry.compaction === 'off');
    if (on === undefined || off === undefined) throw new EvalError(`scenario ${scenario} has no on and off pair`);
    return on.compactions > 0 && off.passed && !on.passed ? [{ scenario, onId: on.id, offId: off.id }] : [];
  });
};

export const contrastiveCasesOf = (report: Pick<ContextReport, 'cases'>): ContrastiveCase[] => contrastiveCasesOfCases(report.cases);

const contrastiveFailuresOf = (cases: readonly ContextCaseReport[]): ContextMetrics['contrastiveFailures'] => {
  const scenarios = [...new Set(cases.map((entry) => entry.scenario))];
  const measurable = scenarios.filter((scenario) => cases.some((entry) => entry.scenario === scenario && entry.compaction === 'on' && entry.compactions > 0));
  return { count: contrastiveCasesOfCases(cases).length, n: measurable.length };
};

type MeasuredCase = { entry: ExpandedCase; measures: RunMeasure[]; transcripts: Transcript[] };

const clusteredOver = (measured: readonly MeasuredCase[], seed: number, pick: (measure: RunMeasure) => Cluster): ClusteredProportion | undefined => {
  const clusters = measured
    .map(({ measures }) => ({ numerator: total(measures, (measure) => pick(measure).numerator), denominator: total(measures, (measure) => pick(measure).denominator) }))
    .filter((cluster) => cluster.denominator > 0);
  if (clusters.length === 0) return undefined;
  const interval = clusterBootstrap(clusters, { seed });
  return {
    successes: total(clusters, (cluster) => cluster.numerator),
    trials: total(clusters, (cluster) => cluster.denominator),
    rate: interval.value,
    low: interval.low,
    high: interval.high,
    clusters: interval.clusters,
  };
};

const definedOnly = <T extends object>(values: T): { [K in keyof T]?: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };

const metricsOf = (cases: readonly ContextCaseReport[], measured: readonly MeasuredCase[], seed: number): ContextMetrics => {
  const measures = measured.flatMap((entry) => entry.measures);
  const compactedRuns = measures.filter((measure) => measure.facts.compactions > 0);
  const governed = measures.flatMap((measure) => (measure.governance === undefined ? [] : [measure.governance]));
  const compactions = total(measures, (measure) => measure.facts.compactions);
  const signals = total(measures, (measure) => measure.signals);
  const tokens = total(measures, (measure) => measure.tokens);
  const successes = measures.filter((measure) => measure.passed).length;
  const cluster = (pick: (measure: RunMeasure) => Cluster) => clusteredOver(measured, seed, pick);
  const none: Cluster = { numerator: 0, denominator: 0 };
  return {
    continuationRate: proportionOrUndefined(compactedRuns.filter((measure) => measure.passed).length, compactedRuns.length),
    contrastiveFailures: contrastiveFailuresOf(cases),
    lossSignalsPerCompaction: compactions === 0 ? undefined : { value: signals / compactions, signals, compactions, n: compactions },
    fabricationRate: cluster((measure) => ({ numerator: measure.facts.fabricatedSummaries, denominator: measure.facts.modelSummaries })),
    identifierRetention: cluster((measure) => ({ numerator: measure.facts.retained, denominator: measure.facts.identifiers })),
    governanceFidelity: cluster((measure) => (measure.governance === undefined ? none : { numerator: measure.governance.bindingLoaded, denominator: measure.governance.binding })),
    governanceConsistency: proportionOrUndefined(governed.filter((counts) => counts.consistent).length, governed.length),
    governanceMinimality: cluster((measure) =>
      measure.governance === undefined || measure.governance.loaded === 0 ? none : { numerator: measure.governance.bindingLoaded, denominator: measure.governance.loaded },
    ),
    memoryStaleRate: cluster((measure) => ({ numerator: measure.recalled.stale, denominator: measure.recalled.recalled })),
    retrievalPrecision: cluster((measure) => (measure.retrieval === undefined ? none : { numerator: measure.retrieval.relevant, denominator: measure.retrieval.retrieved })),
    retrievalRecall: cluster((measure) => (measure.retrieval === undefined ? none : { numerator: measure.retrieval.relevant, denominator: measure.retrieval.gold })),
    tokensPerSuccess: successes === 0 ? undefined : { value: tokens / successes, tokens, successes, n: successes },
    ...definedOnly(
      tokenMetricsOf(
        measured.map(({ measures: caseMeasures }) => ({
          totals: caseTotalsOf(caseMeasures.map((measure) => measure.token)),
          passedRuns: caseMeasures.filter((measure) => measure.passed).length,
          facts: caseMeasures.map((measure) => measure.token),
        })),
        seed,
      ),
    ),
  };
};

export const datasetDigestOf = (dataset: ContextDataset, seed: number): string => sha256Hex(canonicalJson(expandContextDataset(dataset, seed)));

export type BuildContextReportInput = {
  dataset: ContextDataset;
  transcripts: readonly Transcript[];
  model: ContextModel;
  seed: number;
  datasetSeed?: number;
};

export const buildContextReport = (input: BuildContextReportInput): ContextReport => {
  const datasetSeed = input.datasetSeed ?? DEFAULT_DATASET_SEED;
  const expanded = expandContextDataset(input.dataset, datasetSeed);
  const measured: MeasuredCase[] = transcriptsByCase(expanded.cases, input.transcripts).map(({ golden, recorded }) => ({
    entry: golden,
    measures: recorded.map((transcript) => measureRun(golden, transcript)),
    transcripts: recorded,
  }));
  const cases = measured.map(({ entry, measures }) => caseReportOf(entry, measures));
  const measures = measured.flatMap((item) => item.measures);
  const transcripts = measured.flatMap((item) => item.transcripts);
  return {
    format: CONTEXT_REPORT_FORMAT,
    dataset: input.dataset.name,
    datasetDigest: datasetDigestOf(input.dataset, datasetSeed),
    datasetSeed,
    model: input.model,
    modelAliases: [...new Set(measures.flatMap((measure) => (measure.modelAlias === undefined ? [] : [measure.modelAlias])))].sort(),
    metrics: metricsOf(cases, measured, input.seed),
    meaningless: input.model === 'fake' ? [...MODEL_DEPENDENT_METRICS] : [],
    unclassifiedCompactions: total(measures, (measure) => measure.facts.unclassified),
    governanceRunsWithoutEvent: measures.filter((measure) => measure.governance !== undefined && measure.governance.loads === 0).length,
    noiseTokens: total(transcripts, (transcript) => transcript.noiseTokens ?? 0),
    stopped: measured.flatMap(({ transcripts: recorded }) =>
      recorded.flatMap((transcript) => (transcript.stopped === undefined ? [] : [{ caseId: transcript.caseId, runIndex: transcript.runIndex, reason: transcript.stopped }])),
    ),
    cases,
    passed: cases.every((entry) => entry.meetsMinimum),
  };
};

export const describeClustered = (value: ClusteredProportion): string =>
  `${value.successes}/${value.trials} = ${percent(value.rate)} (95% bootstrap over ${value.clusters} case(s) ${percent(value.low)}..${percent(value.high)})`;

const describeOptional = (name: string, value: Proportion | ClusteredProportion | undefined, absence: string): string => {
  if (value === undefined) return `${name} n/a (${absence})`;
  return `${name} ${'clusters' in value ? describeClustered(value) : describeProportion(value)}`;
};

const describeRatio = (name: string, metric: RatioMetric | undefined, absence: string, render: (value: number) => string, unit: string): string => {
  if (metric === undefined) return `${name} n/a (${absence})`;
  const interval = `95% bootstrap ${render(metric.low)}..${render(metric.high)}`;
  return `${name} ${render(metric.value)}${unit} (${interval} over ${metric.clusters} case(s); ${metric.numerator} / ${metric.denominator}), n=${metric.clusters}`;
};

const decimals = (digits: number) => (value: number): string => value.toFixed(digits);

const tokenLines = (metrics: ContextMetrics): string[] => {
  const shares = Object.entries(metrics.layerShares ?? {}).map(([name, share]) => `${name} ${percent(share.value)}`);
  return [
    describeRatio('costPerSuccess', metrics.costPerSuccess, 'a call has no price or no run succeeded', decimals(6), ''),
    describeRatio('uncachedInputPerSuccess', metrics.uncachedInputPerSuccess, 'a call reports no cached input or no run succeeded', decimals(1), ''),
    describeRatio('callsPerSuccess', metrics.callsPerSuccess, 'no call was recorded or no run succeeded', decimals(3), ''),
    describeRatio('latencyPerSuccess', metrics.latencyPerSuccess, 'a call has no timing or no run succeeded', decimals(1), ' ms'),
    metrics.cacheHitRatio === undefined
      ? 'cacheHitRatio n/a (a call reports no cached input or no input was sent)'
      : `cacheHitRatio ${percent(metrics.cacheHitRatio.value)} (95% bootstrap ${percent(metrics.cacheHitRatio.low)}..${percent(metrics.cacheHitRatio.high)} over ${metrics.cacheHitRatio.clusters} case(s); ${metrics.cacheHitRatio.numerator} / ${metrics.cacheHitRatio.denominator}), n=${metrics.cacheHitRatio.clusters}`,
    shares.length === 0 ? 'layerShares n/a (no request recorded its layers)' : `layerShares ${shares.join(', ')} (estimated)`,
  ];
};

export const formatContextReport = (report: ContextReport): string => {
  const { metrics } = report;
  const aliases = report.modelAliases.length === 0 ? 'none recorded' : report.modelAliases.join(', ');
  const lines = [
    `dataset ${report.dataset}: ${report.passed ? 'PASS' : 'FAIL'}`,
    `model: ${report.model} (declared by the operator; the aliases the runs pinned: ${aliases})`,
  ];
  if (report.model === 'fake') {
    lines.push('a fake model proves only that the machinery works; none of these numbers says anything about the quality of the context');
    lines.push(`meaningless for a fake model: ${report.meaningless.join(', ')}`);
  }
  for (const entry of report.cases) {
    lines.push(
      `  ${entry.meetsMinimum ? 'ok  ' : 'FAIL'} ${entry.id} (scenario ${entry.scenario}, compaction ${entry.compaction}): pass rate ${describeProportion(entry.passRate)}, required at least ${percent(entry.minPassRate)}`,
    );
  }
  lines.push(describeOptional('continuationRate', metrics.continuationRate, 'no run compacted'));
  lines.push(`contrastiveFailures ${metrics.contrastiveFailures.count} of ${metrics.contrastiveFailures.n} scenarios, n=${metrics.contrastiveFailures.n}`);
  const loss = metrics.lossSignalsPerCompaction;
  lines.push(
    loss === undefined
      ? 'lossSignalsPerCompaction n/a (no compaction)'
      : `lossSignalsPerCompaction ${loss.value.toFixed(3)} (${loss.signals} signals / ${loss.compactions} compactions), n=${loss.n}`,
  );
  lines.push(describeOptional('fabricationRate', metrics.fabricationRate, 'no model summary'));
  lines.push(describeOptional('identifierRetention', metrics.identifierRetention, 'no critical identifier'));
  lines.push(describeOptional('governanceFidelity', metrics.governanceFidelity, 'no case defines a binding rule'));
  lines.push(describeOptional('governanceConsistency', metrics.governanceConsistency, 'no case defines a binding rule'));
  lines.push(describeOptional('governanceMinimality', metrics.governanceMinimality, 'no governing fact was loaded'));
  lines.push(describeOptional('memoryStaleRate', metrics.memoryStaleRate, 'no memory was recalled'));
  lines.push(describeOptional('retrievalPrecision', metrics.retrievalPrecision, 'no history was read'));
  lines.push(describeOptional('retrievalRecall', metrics.retrievalRecall, 'no case defines a gold range'));
  const tokens = metrics.tokensPerSuccess;
  lines.push(
    tokens === undefined
      ? 'tokensPerSuccess n/a (no passing run)'
      : `tokensPerSuccess ${tokens.value.toFixed(1)} (${tokens.tokens} tokens / ${tokens.successes} successes), n=${tokens.n}`,
  );
  lines.push(...tokenLines(metrics));
  lines.push(`unclassifiedCompactions ${report.unclassifiedCompactions}`);
  lines.push(`governanceRunsWithoutEvent ${report.governanceRunsWithoutEvent} (runs of cases with rules that loaded no governing set; each counts as an empty set)`);
  lines.push(`datasetSeed ${report.datasetSeed}`);
  lines.push(`noiseTokens ${report.noiseTokens} (spent by the noise turns before each task; counted against the dataset cap and not in tokensPerSuccess)`);
  for (const stop of report.stopped) lines.push(`stopped ${stop.caseId} run ${stop.runIndex}: ${stop.reason} (counted as a failed run)`);
  return lines.join('\n');
};

const count = { type: 'integer', minimum: 0 } as const;
const rate = { type: 'number', minimum: 0 } as const;

const closed = (properties: Record<string, unknown>, required: readonly string[]) => ({ type: 'object', properties, required, additionalProperties: false }) as const;

const proportionSchema = closed({ successes: count, trials: count, rate, low: rate, high: rate }, ['successes', 'trials', 'rate', 'low', 'high']);

const clusteredSchema = closed({ successes: count, trials: count, rate, low: rate, high: rate, clusters: count }, ['successes', 'trials', 'rate', 'low', 'high', 'clusters']);

const ratioMetricSchema = closed({ value: rate, numerator: rate, denominator: rate, low: rate, high: rate, clusters: count }, ['value', 'numerator', 'denominator', 'low', 'high', 'clusters']);

const caseTokensSchema = closed(
  {
    calls: count,
    inputTokens: count,
    cachedInputTokens: count,
    uncachedInputTokens: { type: 'number' },
    cost: rate,
    latencyMs: rate,
  },
  ['calls'],
);

const CONTEXT_REPORT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  ...closed(
    {
      format: { const: CONTEXT_REPORT_FORMAT },
      dataset: { type: 'string', minLength: 1 },
      datasetDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      datasetSeed: { type: 'integer', minimum: 0, maximum: MAX_DATASET_SEED },
      model: { enum: [...CONTEXT_MODELS] },
      modelAliases: { type: 'array', items: { type: 'string', minLength: 1 } },
      metrics: closed(
        {
          continuationRate: proportionSchema,
          contrastiveFailures: closed({ count, n: count }, ['count', 'n']),
          lossSignalsPerCompaction: closed({ value: rate, signals: count, compactions: count, n: count }, ['value', 'signals', 'compactions', 'n']),
          fabricationRate: clusteredSchema,
          identifierRetention: clusteredSchema,
          governanceFidelity: clusteredSchema,
          governanceConsistency: proportionSchema,
          governanceMinimality: clusteredSchema,
          memoryStaleRate: clusteredSchema,
          retrievalPrecision: clusteredSchema,
          retrievalRecall: clusteredSchema,
          tokensPerSuccess: closed({ value: rate, tokens: count, successes: count, n: count }, ['value', 'tokens', 'successes', 'n']),
          costPerSuccess: ratioMetricSchema,
          uncachedInputPerSuccess: ratioMetricSchema,
          callsPerSuccess: ratioMetricSchema,
          latencyPerSuccess: ratioMetricSchema,
          cacheHitRatio: ratioMetricSchema,
          layerShares: { type: 'object', additionalProperties: ratioMetricSchema },
        },
        ['contrastiveFailures'],
      ),
      meaningless: { type: 'array', items: { enum: [...MODEL_DEPENDENT_METRICS] } },
      unclassifiedCompactions: count,
      governanceRunsWithoutEvent: count,
      noiseTokens: count,
      stopped: {
        type: 'array',
        items: closed({ caseId: { type: 'string', minLength: 1 }, runIndex: count, reason: { type: 'string', minLength: 1 } }, ['caseId', 'runIndex', 'reason']),
      },
      cases: {
        type: 'array',
        items: closed(
          {
            id: { type: 'string', minLength: 1 },
            scenario: { type: 'string', minLength: 1 },
            compaction: { enum: [...COMPACTION_SETTINGS] },
            runs: count,
            passedRuns: count,
            passed: { type: 'boolean' },
            passRate: proportionSchema,
            minPassRate: rate,
            meetsMinimum: { type: 'boolean' },
            totalTokens: count,
            compactions: count,
            lossSignals: count,
            tokens: caseTokensSchema,
          },
          ['id', 'scenario', 'compaction', 'runs', 'passedRuns', 'passed', 'passRate', 'minPassRate', 'meetsMinimum', 'totalTokens', 'compactions', 'lossSignals'],
        ),
      },
      passed: { type: 'boolean' },
    },
    [
      'format',
      'dataset',
      'datasetDigest',
      'datasetSeed',
      'model',
      'modelAliases',
      'metrics',
      'meaningless',
      'unclassifiedCompactions',
      'governanceRunsWithoutEvent',
      'noiseTokens',
      'stopped',
      'cases',
      'passed',
    ],
  ),
} as const;

const ajv = new Ajv2020.default({ strict: true });
const validateContextReport: ValidateFunction<ContextReport> = ajv.compile<ContextReport>(CONTEXT_REPORT_SCHEMA);

export const parseContextReport = (text: string, source: string): ContextReport => {
  const value = jsonOf(text, source);
  if (!validateContextReport(value)) throw new EvalError(`${source}: not a context report (${describeFirstError(validateContextReport)})`);
  return value;
};

export const encodeContextReport = (report: ContextReport): string => `${JSON.stringify(report, null, 2)}\n`;
