import { canonicalJson, defineProductSchema, isRecord, sha256Hex } from '@momonga/foundation';
import type { ProductValidator } from '@momonga/foundation';
import { CACHE_READS_NOT_REPORTED, MODEL_KINDS, PRICE_NOT_RECORDED, UNPRICED_CODES, UNPRICED_CODE_TEXT, escapeTerminalLine, modelKindOf } from '@momonga/protocol';
import type { ModelKind } from '@momonga/protocol';
import { clusterBootstrap } from './bootstrap.ts';
import type { Cluster } from './bootstrap.ts';
import { COMPACTION_SETTINGS, expandContextDataset } from './context-dataset.ts';
import { RESOLVED_POLICY_SCHEMA } from './context-policy.ts';
import type { PolicyOverlay } from './context-policy.ts';
import { NEW_PAIR_COMMANDS, RETIRED_POLICY_REASON } from './retired-formats.ts';
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
import { caseTotalsOf, hasInconsistentCacheRead, tokenFactsOf, tokenMetricsOf } from './token-metrics.ts';
import type { CaseTokenTotals, RatioMetric, TokenFacts } from './token-metrics.ts';
import type { Answerer, Transcript } from './transcript.ts';

export const CONTEXT_REPORT_FORMAT = 'momonga-eval-context-report/7';
const RETIRED_CONTEXT_REPORT_FORMATS: Readonly<Record<string, string>> = {
  'momonga-eval-context-report/1': 'the policy and the code digest of the runs',
  'momonga-eval-context-report/2': 'the targets that answered the runs and whether each is a model or a script',
  'momonga-eval-context-report/3': 'an answerer whose adapter and model are unknown (a paid answer that recorded no answering target)',
  'momonga-eval-context-report/4': 'which calls the upstream reported cache reads for (an unreported cache read was recorded as 0)',
  'momonga-eval-context-report/5': 'the price outcome of the calls (why a cost is unmeasured)',
  'momonga-eval-context-report/6': 'the models the runs used (they were recorded as alias names)',
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
  reflectionCostPerSuccess?: RatioMetric;
  reflectionCallsPerSuccess?: RatioMetric;
  costPerSuccessAll?: RatioMetric;
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
  models: string[];
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
  model: string | undefined;
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
    model: transcript.run.model,
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
  const known = transcripts.flatMap(({ policy, codeDigest }): RunIdentity[] => (policy === null || codeDigest === null ? [] : [{ policy, codeDigest }]));
  const [first] = known;
  if (first === undefined) return { policy: null, codeDigest: null };
  if (known.length < transcripts.length) {
    throw new EvalError(`${transcripts.length - known.length} of ${transcripts.length} transcripts record no policy and no code digest, so the report would mix runs of known and unknown identity`);
  }
  const policies = new Set(known.map((identity) => canonicalJson(identity.policy)));
  if (policies.size > 1) throw new EvalError('the transcripts record more than one resolved policy, so they do not measure one run configuration');
  const digests = new Set(known.map((identity) => identity.codeDigest));
  if (digests.size > 1) throw new EvalError(`the transcripts record different codeDigest values (${[...digests].join(', ')}), so they were not produced by one build`);
  return first;
};

const answeredKey = (answerer: Answerer): string => canonicalJson(answerer);

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
    models: [...new Set(measures.flatMap((measure) => (measure.model === undefined ? [] : [measure.model])))].sort(),
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

export type CacheReadMetric = 'uncachedInputPerSuccess' | 'cacheHitRatio';

type CacheReadCounts = { calls: number; notReported: number; casesWithNotReported: number };

const CACHE_READ_CAUSES = {
  notReportedInAll: (counts: CacheReadCounts): string => `${CACHE_READS_NOT_REPORTED} in all ${counts.calls} call(s)`,
  notReportedInSome: (counts: CacheReadCounts): string => `${CACHE_READS_NOT_REPORTED} in ${counts.notReported} of ${counts.calls} call(s)`,
  measuredOver: (counts: CacheReadCounts): string =>
    `over ${counts.calls - counts.notReported} of ${counts.calls} call(s), ${CACHE_READS_NOT_REPORTED} in ${counts.notReported} call(s) of ${counts.casesWithNotReported} case(s)`,
  inconsistent: 'a call reports more cached and written input than input',
  noSuccess: 'no run succeeded',
  noInput: 'no input was sent',
} as const;

type TokenCounted = { tokens?: CaseTokenTotals | undefined };

const tokenTotalsOf = (cases: readonly TokenCounted[]): CaseTokenTotals[] => cases.flatMap((entry) => (entry.tokens === undefined ? [] : [entry.tokens]));

const cacheReadCountsOf = (cases: readonly TokenCounted[]): CacheReadCounts => {
  const totals = tokenTotalsOf(cases);
  return {
    calls: totals.reduce((sum, entry) => sum + entry.calls, 0),
    notReported: totals.reduce((sum, entry) => sum + entry.cacheReadNotReportedCalls, 0),
    casesWithNotReported: totals.filter((entry) => entry.cacheReadNotReportedCalls > 0).length,
  };
};

export const unmeasuredCauseOf = (metric: CacheReadMetric, cases: readonly TokenCounted[]): string => {
  const totals = tokenTotalsOf(cases);
  const counts = cacheReadCountsOf(cases);
  if (counts.calls === 0) return CACHE_READ_CAUSES.noInput;
  if (counts.notReported === counts.calls) return CACHE_READ_CAUSES.notReportedInAll(counts);
  if (metric === 'uncachedInputPerSuccess' && counts.notReported > 0) return CACHE_READ_CAUSES.notReportedInSome(counts);
  if (totals.some(hasInconsistentCacheRead)) return CACHE_READ_CAUSES.inconsistent;
  return metric === 'uncachedInputPerSuccess' ? CACHE_READ_CAUSES.noSuccess : CACHE_READ_CAUSES.noInput;
};

const pricedCallCount = (calls: number, cases: number, text: string): string => `${text} in ${calls} call(s) of ${cases} case(s)`;

export const unmeasuredCostCauseOf = (cases: readonly TokenCounted[]): string => {
  const totals = tokenTotalsOf(cases);
  const causes = [
    ...UNPRICED_CODES.map((code) => ({ text: UNPRICED_CODE_TEXT[code], countOf: (entry: CaseTokenTotals) => entry.unpriced?.[code] ?? 0 })),
    { text: PRICE_NOT_RECORDED, countOf: (entry: CaseTokenTotals) => entry.unrecordedPrice ?? 0 },
  ].flatMap(({ text, countOf }) => {
    const calls = totals.reduce((sum, entry) => sum + countOf(entry), 0);
    return calls === 0 ? [] : [pricedCallCount(calls, totals.filter((entry) => countOf(entry) > 0).length, text)];
  });
  if (causes.length > 0) return causes.join('; ');
  return CACHE_READ_CAUSES.noSuccess;
};

const cacheHitRatioLine = (metric: RatioMetric | undefined, cases: readonly ContextCaseReport[]): string => {
  if (metric === undefined) return `cacheHitRatio n/a (${unmeasuredCauseOf('cacheHitRatio', cases)})`;
  const counts = cacheReadCountsOf(cases);
  const over = counts.notReported === 0 ? '' : `, ${CACHE_READ_CAUSES.measuredOver(counts)}`;
  return `cacheHitRatio ${percent(metric.value)} (95% bootstrap ${percent(metric.low)}..${percent(metric.high)} over ${metric.clusters} case(s); ${metric.numerator} / ${metric.denominator}), n=${metric.clusters}${over}`;
};

const reflectionUnmeasuredCause = (cases: readonly ContextCaseReport[]): string => {
  const unsettled = cases.filter((entry) => entry.tokens !== undefined && !entry.tokens.reflection.settled);
  if (unsettled.length === 0) return 'a reflection charge has no recorded cost, or no run succeeded';
  const runs = unsettled.reduce((sum, entry) => sum + (entry.tokens?.unsettledReflections ?? 0), 0);
  return `${runs} run(s) in ${unsettled.map((entry) => entry.id).join(', ')} have a reflection that is pending, running past its bound or not recorded`;
};

const reflectionLines = (metrics: ContextMetrics, cases: readonly ContextCaseReport[]): string[] => {
  const cause = reflectionUnmeasuredCause(cases);
  return [
    describeRatio('reflectionCostPerSuccess', metrics.reflectionCostPerSuccess, cause, decimals(6), ''),
    describeRatio('reflectionCallsPerSuccess', metrics.reflectionCallsPerSuccess, cause, decimals(3), ''),
    describeRatio('costPerSuccessAll', metrics.costPerSuccessAll, `${unmeasuredCostCauseOf(cases)}; ${cause}`, decimals(6), ''),
  ];
};

const tokenLines = (metrics: ContextMetrics, cases: readonly ContextCaseReport[]): string[] => {
  const shares = Object.entries(metrics.layerShares ?? {}).map(([name, share]) => `${name} ${percent(share.value)}`);
  return [
    describeRatio('costPerSuccess', metrics.costPerSuccess, unmeasuredCostCauseOf(cases), decimals(6), ''),
    describeRatio('uncachedInputPerSuccess', metrics.uncachedInputPerSuccess, unmeasuredCauseOf('uncachedInputPerSuccess', cases), decimals(1), ''),
    describeRatio('callsPerSuccess', metrics.callsPerSuccess, 'no call was recorded or no run succeeded', decimals(3), ''),
    describeRatio('latencyPerSuccess', metrics.latencyPerSuccess, 'a call has no timing or no run succeeded', decimals(1), ' ms'),
    cacheHitRatioLine(metrics.cacheHitRatio, cases),
    shares.length === 0 ? 'layerShares n/a (no request recorded its layers)' : `layerShares ${shares.join(', ')} (estimated)`,
    ...reflectionLines(metrics, cases),
  ];
};

const answeredLine = (report: Pick<ContextReport, 'answeredBy' | 'unrecordedAnswers'>): string => {
  const targets = report.answeredBy.map((answerer) => `${answerer.target} (${answerer.answers})`);
  const unrecorded = report.unrecordedAnswers === 0 ? [] : [`${report.unrecordedAnswers} transcript(s) record no answering target`];
  return [...targets, ...unrecorded].join(', ') || 'no target recorded';
};

export const formatContextReport = (report: ContextReport): string => {
  const { metrics } = report;
  const used = report.models.length === 0 ? 'none recorded' : report.models.join(', ');
  const lines = [
    `dataset ${report.dataset}: ${report.passed ? 'PASS' : 'FAIL'}`,
    `model: ${report.model} (derived from the pinned provenance of the models that answered: ${answeredLine(report)}; the models the runs used: ${used})`,
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

const reflectionColumnSchema = closed({ calls: count, inputTokens: count, cost: rate, settled: { type: 'boolean' } }, ['settled']);

const caseTokensSchema = closed(
  {
    reflection: reflectionColumnSchema,
    calls: count,
    unsettledReflections: count,
    cacheReadNotReportedCalls: count,
    inputTokens: count,
    cacheReportedInputTokens: count,
    cachedInputTokens: count,
    uncachedInputTokens: { type: 'number' },
    cost: rate,
    unpriced: closed(Object.fromEntries(UNPRICED_CODES.map((code) => [code, { type: 'integer', minimum: 1 }])), []),
    unrecordedPrice: { type: 'integer', minimum: 1 },
    latencyMs: rate,
  },
  ['reflection', 'calls', 'unsettledReflections', 'cacheReadNotReportedCalls'],
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
      answeredBy: {
        type: 'array',
        items: closed(
          { target: { type: 'string', minLength: 1 }, adapter: { type: 'string' }, upstreamModel: { type: 'string' }, answers: { enum: ['model', 'script', 'unknown'] } },
          ['target', 'answers'],
        ),
      },
      unrecordedAnswers: count,
      models: { type: 'array', items: { type: 'string', minLength: 1 } },
      policy: { anyOf: [RESOLVED_POLICY_SCHEMA, { type: 'null' }] },
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
          reflectionCostPerSuccess: ratioMetricSchema,
          reflectionCallsPerSuccess: ratioMetricSchema,
          costPerSuccessAll: ratioMetricSchema,
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
      'models',
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
      `${source}: ${value['format']} reports do not record ${RETIRED_CONTEXT_REPORT_FORMATS[value['format']]}, so ${value['format']} is retired and cannot be compared as ${CONTEXT_REPORT_FORMAT}; every report older than ${CONTEXT_REPORT_FORMAT} has its ${RETIRED_POLICY_REASON}, so build a ${CONTEXT_REPORT_FORMAT} pair from one bundle: ${NEW_PAIR_COMMANDS}`,
    );
  }
  const verdict = validateContextReport(value);
  if (!verdict.valid) throw new EvalError(`${source}: not a context report (${describeFirstError(verdict.errors)})`);
  return verdict.value;
};

export const encodeContextReport = (report: ContextReport): string => `${JSON.stringify(report, null, 2)}\n`;
