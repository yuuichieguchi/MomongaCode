import { canonicalJson, defineProductSchema, isRecord, sha256Hex } from '@momonga/foundation';
import type { ProductValidator } from '@momonga/foundation';
import { MODEL_KINDS, escapeTerminalLine, modelKindOf } from '@momonga/protocol';
import type { ModelKind } from '@momonga/protocol';
import { clusterBootstrap } from './bootstrap.ts';
import type { Cluster } from './bootstrap.ts';
import { COMPACTION_SETTINGS, expandContextDataset } from './context-dataset.ts';
import { POLICY_OVERLAY_SCHEMA, normalisePolicyOverlay } from './context-policy.ts';
import type { PolicyOverlay } from './context-policy.ts';
import type { CompactionSetting, ContextDataset, ExpandedCase } from './context-dataset.ts';
import { compactionFactsOf, goldRangesOf, governanceCountsOf, lossSignalsOf, recalledOf, retrievalOf } from './context-metrics.ts';
import { QUALITY_METRICS } from './context-quality.ts';
import type { QualityCell, QualityMetricName } from './context-quality.ts';
import type { CompactionFacts, GovernanceCounts, Recalled, Retrieval } from './context-metrics.ts';
import { describeFirstError, jsonOf } from './dataset.ts';
import { grade } from './graders.ts';
import { describeProportion, percent, proportionOrUndefined } from './report.ts';
import { EvalError, transcriptsByCase } from './runner.ts';
import type { Proportion } from './stats.ts';
import { caseTotalsOf, tokenFactsOf, tokenMetricsOf } from './token-metrics.ts';
import type { CaseTokenTotals, RatioMetric, TokenFacts } from './token-metrics.ts';
import type { Answerer, Transcript } from './transcript.ts';

export const CONTEXT_REPORT_FORMAT = 'momonga-eval-context-report/3';
const RETIRED_CONTEXT_REPORT_FORMATS: Readonly<Record<string, string>> = {
  'momonga-eval-context-report/1': 'the policy and the code digest of the runs',
  'momonga-eval-context-report/2': 'the targets that answered the runs and whether each is a model or a script',
};

export const CONTEXT_MODELS = MODEL_KINDS;
export type ContextModel = ModelKind;

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
  quality: Record<string, QualityCell>;
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
  answeredBy: Answerer[];
  unrecordedAnswers: number;
  modelAliases: string[];
  policy: PolicyOverlay | null;
  codeDigest: string | null;
  metrics: ContextMetrics;
  meaningless: ModelDependentMetric[];
  unclassifiedCompactions: number;
  governanceRunsWithoutEvent: number;
  noiseTokens: number;
  unsettledNoiseReflections: number;
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
  quality: Record<QualityMetricName, Cluster>;
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

const measureRun = (entry: ExpandedCase, transcript: Transcript): RunMeasure => {
  const runs = [transcript.events, ...transcript.children.map((child) => child.events)];
  const facts = sumFacts(runs.map((events) => compactionFactsOf(events)));
  if (entry.compaction === 'off' && facts.compactions > 0) {
    throw new EvalError(`case ${entry.id} has compaction off but its run ${transcript.run.id} holds ${facts.compactions} compaction(s), so the pair would compare nothing`);
  }
  const stopped = transcript.stopped !== undefined;
  const governance = governanceCountsOf(entry.rules, transcript.events, transcript.ruleIds);
  const recalled = recalledOf(transcript.events);
  const retrieval = entry.gold === undefined || stopped ? undefined : retrievalOf(goldRangesOf(entry.gold, transcript.events), transcript.events);
  const passed = !stopped && grade(entry.graders, transcript).passed;
  const none: Cluster = { numerator: 0, denominator: 0 };
  return {
    passed,
    tokens: transcript.run.usage.totalTokens,
    facts,
    signals: total(runs, (events) => lossSignalsOf(events).length),
    governance,
    recalled,
    retrieval,
    modelAlias: transcript.run.modelAlias,
    quality: {
      continuationRate: { numerator: facts.compactions > 0 && passed ? 1 : 0, denominator: facts.compactions > 0 ? 1 : 0 },
      governanceFidelity: governance === undefined ? none : { numerator: governance.bindingLoaded, denominator: governance.binding },
      governanceConsistency: governance === undefined ? none : { numerator: governance.consistent ? 1 : 0, denominator: 1 },
      governanceMinimality: governance === undefined || governance.loaded === 0 ? none : { numerator: governance.bindingLoaded, denominator: governance.loaded },
      memoryStaleRate: { numerator: recalled.stale, denominator: recalled.recalled },
      retrievalPrecision: retrieval === undefined ? none : { numerator: retrieval.relevant, denominator: retrieval.retrieved },
      retrievalRecall: retrieval === undefined ? none : { numerator: retrieval.relevant, denominator: retrieval.gold },
    },
    token: tokenFactsOf(runs, stopped ? { state: 'none' } : transcript.reflection),
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
    quality: Object.fromEntries(
      QUALITY_METRICS.map(({ name }) => [name, { numerator: total(measures, (measure) => measure.quality[name].numerator), denominator: total(measures, (measure) => measure.quality[name].denominator) }]),
    ),
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

const proportionOf = (measures: readonly RunMeasure[], name: QualityMetricName): Proportion | undefined =>
  proportionOrUndefined(
    total(measures, (measure) => measure.quality[name].numerator),
    total(measures, (measure) => measure.quality[name].denominator),
  );

const metricsOf = (cases: readonly ContextCaseReport[], measured: readonly MeasuredCase[], seed: number): ContextMetrics => {
  const measures = measured.flatMap((entry) => entry.measures);
  const compactions = total(measures, (measure) => measure.facts.compactions);
  const signals = total(measures, (measure) => measure.signals);
  const tokens = total(measures, (measure) => measure.tokens);
  const successes = measures.filter((measure) => measure.passed).length;
  const cluster = (pick: (measure: RunMeasure) => Cluster) => clusteredOver(measured, seed, pick);
  const qualityCluster = (name: QualityMetricName) => cluster((measure) => measure.quality[name]);
  return {
    continuationRate: proportionOf(measures, 'continuationRate'),
    contrastiveFailures: contrastiveFailuresOf(cases),
    lossSignalsPerCompaction: compactions === 0 ? undefined : { value: signals / compactions, signals, compactions, n: compactions },
    fabricationRate: cluster((measure) => ({ numerator: measure.facts.fabricatedSummaries, denominator: measure.facts.modelSummaries })),
    identifierRetention: cluster((measure) => ({ numerator: measure.facts.retained, denominator: measure.facts.identifiers })),
    governanceFidelity: qualityCluster('governanceFidelity'),
    governanceConsistency: proportionOf(measures, 'governanceConsistency'),
    governanceMinimality: qualityCluster('governanceMinimality'),
    memoryStaleRate: qualityCluster('memoryStaleRate'),
    retrievalPrecision: qualityCluster('retrievalPrecision'),
    retrievalRecall: qualityCluster('retrievalRecall'),
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
  seed: number;
  datasetSeed?: number;
};

type RunIdentity = { policy: PolicyOverlay; codeDigest: string };

const identityOf = (transcripts: readonly Transcript[]): { policy: PolicyOverlay | null; codeDigest: string | null } => {
  if (transcripts.length === 0) throw new EvalError('the report has no transcript to take the policy and the code digest from');
  const known = transcripts.flatMap(({ policy, codeDigest }): RunIdentity[] => (policy === null || codeDigest === null ? [] : [{ policy: normalisePolicyOverlay(policy), codeDigest }]));
  const [first] = known;
  if (first === undefined) return { policy: null, codeDigest: null };
  if (known.length < transcripts.length) {
    throw new EvalError(`${transcripts.length - known.length} of ${transcripts.length} transcripts record no policy and no code digest, so the report would mix runs of known and unknown identity`);
  }
  const policies = new Set(known.map((identity) => canonicalJson(identity.policy)));
  if (policies.size > 1) throw new EvalError('the transcripts record different policy overlays, so they do not measure one run configuration');
  const digests = new Set(known.map((identity) => identity.codeDigest));
  if (digests.size > 1) throw new EvalError(`the transcripts record different codeDigest values (${[...digests].join(', ')}), so they were not produced by one build`);
  return first;
};

const answeredKey = (answerer: Answerer): string => canonicalJson([answerer.target, answerer.adapter, answerer.upstreamModel, answerer.answers]);

export const uniqueAnswerers = (answerers: readonly Answerer[]): Answerer[] => {
  const unique = new Map<string, Answerer>();
  for (const answerer of answerers) unique.set(answeredKey(answerer), answerer);
  return [...unique].sort(([left], [right]) => (left < right ? -1 : 1)).map(([, answerer]) => answerer);
};

const answeredByOf = (transcripts: readonly Transcript[]): Answerer[] => uniqueAnswerers(transcripts.flatMap((transcript) => transcript.answeredBy ?? []));

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
  const identity = identityOf(transcripts);
  const answeredBy = answeredByOf(transcripts);
  const unrecordedAnswers = transcripts.filter((transcript) => transcript.answeredBy === undefined).length;
  const model = modelKindOf(answeredBy, unrecordedAnswers);
  return {
    format: CONTEXT_REPORT_FORMAT,
    dataset: input.dataset.name,
    datasetDigest: datasetDigestOf(input.dataset, datasetSeed),
    datasetSeed,
    model,
    answeredBy,
    unrecordedAnswers,
    modelAliases: [...new Set(measures.flatMap((measure) => (measure.modelAlias === undefined ? [] : [measure.modelAlias])))].sort(),
    policy: identity.policy,
    codeDigest: identity.codeDigest,
    metrics: metricsOf(cases, measured, input.seed),
    meaningless: model === 'fake' ? [...MODEL_DEPENDENT_METRICS] : [],
    unclassifiedCompactions: total(measures, (measure) => measure.facts.unclassified),
    governanceRunsWithoutEvent: measures.filter((measure) => measure.governance !== undefined && measure.governance.loads === 0).length,
    noiseTokens: total(transcripts, (transcript) => transcript.noiseTokens ?? 0),
    unsettledNoiseReflections: total(transcripts, (transcript) => transcript.noiseReflectionsUnsettled ?? 0),
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

const unsettledLine = (cases: readonly ContextCaseReport[]): string[] => {
  const unsettled = cases.filter((entry) => (entry.tokens?.unsettledReflections ?? 0) > 0);
  if (unsettled.length === 0) return [];
  const runs = unsettled.reduce((sum, entry) => sum + (entry.tokens?.unsettledReflections ?? 0), 0);
  return [`reflection: ${runs} run(s) in ${unsettled.map((entry) => entry.id).join(', ')} have a reflection that is pending, running past its bound or not recorded, so the per-success token metrics and cacheHitRatio are n/a`];
};

const tokenLines = (metrics: ContextMetrics, cases: readonly ContextCaseReport[]): string[] => {
  const shares = Object.entries(metrics.layerShares ?? {}).map(([name, share]) => `${name} ${percent(share.value)}`);
  return [
    ...unsettledLine(cases),
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

const answeredLine = (report: Pick<ContextReport, 'answeredBy' | 'unrecordedAnswers'>): string => {
  const targets = report.answeredBy.map((answerer) => `${answerer.target} (${answerer.answers})`);
  const unrecorded = report.unrecordedAnswers === 0 ? [] : [`${report.unrecordedAnswers} transcript(s) record no answering target`];
  return [...targets, ...unrecorded].join(', ') || 'no target recorded';
};

export const formatContextReport = (report: ContextReport): string => {
  const { metrics } = report;
  const aliases = report.modelAliases.length === 0 ? 'none recorded' : report.modelAliases.join(', ');
  const lines = [
    `dataset ${report.dataset}: ${report.passed ? 'PASS' : 'FAIL'}`,
    `model: ${report.model} (derived from the pinned provenance of the targets that answered: ${answeredLine(report)}; the aliases the runs pinned: ${aliases})`,
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
  lines.push(...tokenLines(metrics, report.cases));
  lines.push(`unclassifiedCompactions ${report.unclassifiedCompactions}`);
  lines.push(`governanceRunsWithoutEvent ${report.governanceRunsWithoutEvent} (runs of cases with rules that loaded no governing set; each counts as an empty set)`);
  lines.push(`datasetSeed ${report.datasetSeed}`);
  lines.push(`noiseTokens ${report.noiseTokens} (spent by the noise turns and their reflections before each task; counted against the dataset cap and not in tokensPerSuccess)`);
  lines.push(`noise reflections unsettled ${report.unsettledNoiseReflections} (a reflection of a noise run still pending or running past its bound; the charges recorded so far are in noiseTokens, and the cases stay measured)`);
  for (const stop of report.stopped) lines.push(`stopped ${stop.caseId} run ${stop.runIndex}: ${stop.reason} (counted as a failed run)`);
  return lines.map(escapeTerminalLine).join('\n');
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
    unsettledReflections: count,
    inputTokens: count,
    cachedInputTokens: count,
    uncachedInputTokens: { type: 'number' },
    cost: rate,
    latencyMs: rate,
  },
  ['calls', 'unsettledReflections'],
);

const { $schema: _policyDialect, ...policySchema } = POLICY_OVERLAY_SCHEMA;

const CONTEXT_REPORT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  ...closed(
    {
      format: { const: CONTEXT_REPORT_FORMAT },
      dataset: { type: 'string', minLength: 1 },
      datasetDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      datasetSeed: { type: 'integer', minimum: 0, maximum: MAX_DATASET_SEED },
      model: { enum: [...CONTEXT_MODELS] },
      answeredBy: {
        type: 'array',
        items: closed(
          { target: { type: 'string', minLength: 1 }, adapter: { type: 'string' }, upstreamModel: { type: 'string' }, answers: { enum: ['model', 'script', 'unknown'] } },
          ['target', 'adapter', 'upstreamModel', 'answers'],
        ),
      },
      unrecordedAnswers: count,
      modelAliases: { type: 'array', items: { type: 'string', minLength: 1 } },
      policy: { anyOf: [policySchema, { type: 'null' }] },
      codeDigest: { anyOf: [{ type: 'string', pattern: '^[0-9a-f]{64}$' }, { type: 'null' }] },
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
      unsettledNoiseReflections: count,
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
            quality: closed(
              Object.fromEntries(QUALITY_METRICS.map(({ name }) => [name, closed({ numerator: count, denominator: count }, ['numerator', 'denominator'])])),
              QUALITY_METRICS.map(({ name }) => name),
            ),
            tokens: caseTokensSchema,
          },
          ['id', 'scenario', 'compaction', 'runs', 'passedRuns', 'passed', 'passRate', 'minPassRate', 'meetsMinimum', 'totalTokens', 'compactions', 'lossSignals', 'quality'],
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
      'answeredBy',
      'unrecordedAnswers',
      'modelAliases',
      'policy',
      'codeDigest',
      'metrics',
      'meaningless',
      'unclassifiedCompactions',
      'governanceRunsWithoutEvent',
      'noiseTokens',
      'unsettledNoiseReflections',
      'stopped',
      'cases',
      'passed',
    ],
  ),
} as const;

const validateContextReport: ProductValidator<ContextReport> = defineProductSchema('eval/context-report', CONTEXT_REPORT_SCHEMA);

export const parseContextReport = (text: string, source: string): ContextReport => {
  const value = jsonOf(text, source);
  if (isRecord(value) && typeof value['format'] === 'string' && Object.hasOwn(RETIRED_CONTEXT_REPORT_FORMATS, value['format'])) {
    throw new EvalError(
      `${source}: ${value['format']} reports do not record ${RETIRED_CONTEXT_REPORT_FORMATS[value['format']]}, so ${value['format']} is retired and cannot be compared as ${CONTEXT_REPORT_FORMAT}; build a ${CONTEXT_REPORT_FORMAT} base from one bundle: run \`momonga eval context <dataset> --alias <alias> --report <off report>\` without --settings, then \`momonga eval context <dataset> --alias <alias> --settings <policy file> --report <on report>\`, then \`momonga eval compare <off report> <on report> --gate token\``,
    );
  }
  const verdict = validateContextReport(value);
  if (!verdict.valid) throw new EvalError(`${source}: not a context report (${describeFirstError(verdict.errors)})`);
  return verdict.value;
};

export const encodeContextReport = (report: ContextReport): string => `${JSON.stringify(report, null, 2)}\n`;
