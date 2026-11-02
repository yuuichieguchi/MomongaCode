import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { COMPACTION_SETTINGS } from './context-dataset.ts';
import type { CompactionSetting, ContextCase, ContextDataset } from './context-dataset.ts';
import { compactionFactsOf, governanceCountsOf, lossSignalsOf, recalledOf, retrievalOf } from './context-metrics.ts';
import type { CompactionFacts, GovernanceCounts, Recalled, Retrieval } from './context-metrics.ts';
import { describeFirstError, jsonOf } from './dataset.ts';
import { grade } from './graders.ts';
import { describeProportion, percent, proportionOrUndefined } from './report.ts';
import { EvalError, transcriptsByCase } from './runner.ts';
import type { Proportion } from './stats.ts';
import type { Transcript } from './transcript.ts';

export const CONTEXT_REPORT_FORMAT = 'momonga-eval-context-report/1';

export const CONTEXT_MODELS = ['fake', 'real'] as const;
export type ContextModel = (typeof CONTEXT_MODELS)[number];

export const MODEL_DEPENDENT_METRICS = [
  'continuationRate',
  'contrastiveFailures',
  'fabricationRate',
  'identifierRetention',
  'lossSignalsPerCompaction',
  'retrievalPrecision',
  'retrievalRecall',
  'tokensPerSuccess',
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
};

export type ContextMetrics = {
  continuationRate: Proportion | undefined;
  contrastiveFailures: { count: number; n: number };
  lossSignalsPerCompaction: { value: number; signals: number; compactions: number; n: number } | undefined;
  fabricationRate: Proportion | undefined;
  identifierRetention: Proportion | undefined;
  governanceFidelity: Proportion | undefined;
  governanceConsistency: Proportion | undefined;
  governanceMinimality: Proportion | undefined;
  memoryStaleRate: Proportion | undefined;
  retrievalPrecision: Proportion | undefined;
  retrievalRecall: Proportion | undefined;
  tokensPerSuccess: { value: number; tokens: number; successes: number; n: number } | undefined;
};

export type ContextReport = {
  format: typeof CONTEXT_REPORT_FORMAT;
  dataset: string;
  model: ContextModel;
  metrics: ContextMetrics;
  meaningless: ModelDependentMetric[];
  unclassifiedCompactions: number;
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
};

const measureRun = (entry: ContextCase, transcript: Transcript): RunMeasure => ({
  passed: grade(entry.graders, transcript).passed,
  tokens: transcript.run.usage.totalTokens,
  facts: compactionFactsOf(transcript.events),
  signals: lossSignalsOf(transcript.events).length,
  governance: governanceCountsOf(entry.rules, transcript.events),
  recalled: recalledOf(transcript.events),
  retrieval: entry.gold === undefined ? undefined : retrievalOf(entry.gold, transcript.events),
});

const total = <T>(items: readonly T[], pick: (item: T) => number): number => items.reduce((sum, item) => sum + pick(item), 0);

const caseReportOf = (entry: ContextCase, measures: readonly RunMeasure[]): ContextCaseReport => {
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
  };
};

const contrastiveFailuresOf = (cases: readonly ContextCaseReport[]): ContextMetrics['contrastiveFailures'] => {
  const scenarios = [...new Set(cases.map((entry) => entry.scenario))];
  const failures = scenarios.filter((scenario) => {
    const on = cases.find((entry) => entry.scenario === scenario && entry.compaction === 'on');
    const off = cases.find((entry) => entry.scenario === scenario && entry.compaction === 'off');
    if (on === undefined || off === undefined) throw new EvalError(`scenario ${scenario} has no on and off pair`);
    return off.passed && !on.passed;
  });
  return { count: failures.length, n: scenarios.length };
};

const metricsOf = (cases: readonly ContextCaseReport[], graded: readonly { entry: ContextCase; measure: RunMeasure }[]): ContextMetrics => {
  const measures = graded.map(({ measure }) => measure);
  const onRuns = graded.filter(({ entry }) => entry.compaction === 'on');
  const governed = measures.flatMap((measure) => (measure.governance === undefined ? [] : [measure.governance]));
  const minimal = governed.filter((counts) => counts.loaded > 0);
  const retrievals = measures.flatMap((measure) => (measure.retrieval === undefined ? [] : [measure.retrieval]));
  const compactions = total(measures, (measure) => measure.facts.compactions);
  const signals = total(measures, (measure) => measure.signals);
  const tokens = total(measures, (measure) => measure.tokens);
  const successes = measures.filter((measure) => measure.passed).length;
  const relevant = total(retrievals, (retrieval) => retrieval.relevant);
  return {
    continuationRate: proportionOrUndefined(onRuns.filter(({ measure }) => measure.passed).length, onRuns.length),
    contrastiveFailures: contrastiveFailuresOf(cases),
    lossSignalsPerCompaction: compactions === 0 ? undefined : { value: signals / compactions, signals, compactions, n: compactions },
    fabricationRate: proportionOrUndefined(total(measures, (measure) => measure.facts.fabricatedSummaries), total(measures, (measure) => measure.facts.modelSummaries)),
    identifierRetention: proportionOrUndefined(total(measures, (measure) => measure.facts.retained), total(measures, (measure) => measure.facts.identifiers)),
    governanceFidelity: proportionOrUndefined(total(governed, (counts) => counts.bindingLoaded), total(governed, (counts) => counts.binding)),
    governanceConsistency: proportionOrUndefined(governed.filter((counts) => counts.consistent).length, governed.length),
    governanceMinimality: proportionOrUndefined(total(minimal, (counts) => counts.bindingLoaded), total(minimal, (counts) => counts.loaded)),
    memoryStaleRate: proportionOrUndefined(total(measures, (measure) => measure.recalled.stale), total(measures, (measure) => measure.recalled.recalled)),
    retrievalPrecision: proportionOrUndefined(relevant, total(retrievals, (retrieval) => retrieval.retrieved)),
    retrievalRecall: proportionOrUndefined(relevant, total(retrievals, (retrieval) => retrieval.gold)),
    tokensPerSuccess: successes === 0 ? undefined : { value: tokens / successes, tokens, successes, n: successes },
  };
};

export const buildContextReport = (input: { dataset: ContextDataset; transcripts: readonly Transcript[]; model: ContextModel }): ContextReport => {
  const measured = transcriptsByCase(input.dataset.cases, input.transcripts).map(({ golden, recorded }) => ({
    entry: golden,
    measures: recorded.map((transcript) => measureRun(golden, transcript)),
  }));
  const graded = measured.flatMap(({ entry, measures }) => measures.map((measure) => ({ entry, measure })));
  const cases = measured.map(({ entry, measures }) => caseReportOf(entry, measures));
  return {
    format: CONTEXT_REPORT_FORMAT,
    dataset: input.dataset.name,
    model: input.model,
    metrics: metricsOf(cases, graded),
    meaningless: input.model === 'fake' ? [...MODEL_DEPENDENT_METRICS] : [],
    unclassifiedCompactions: total(graded, ({ measure }) => measure.facts.unclassified),
    cases,
    passed: cases.every((entry) => entry.meetsMinimum),
  };
};

const describeOptional = (name: string, value: Proportion | undefined, absence: string): string =>
  `${name} ${value === undefined ? `n/a (${absence})` : describeProportion(value)}`;

export const formatContextReport = (report: ContextReport): string => {
  const { metrics } = report;
  const lines = [`dataset ${report.dataset}: ${report.passed ? 'PASS' : 'FAIL'}`, `model: ${report.model}`];
  if (report.model === 'fake') {
    lines.push('a fake model proves only that the machinery works; none of these numbers says anything about the quality of the context');
    lines.push(`meaningless for a fake model: ${report.meaningless.join(', ')}`);
  }
  for (const entry of report.cases) {
    lines.push(
      `  ${entry.meetsMinimum ? 'ok  ' : 'FAIL'} ${entry.id} (scenario ${entry.scenario}, compaction ${entry.compaction}): pass rate ${describeProportion(entry.passRate)}, required at least ${percent(entry.minPassRate)}`,
    );
  }
  lines.push(describeOptional('continuationRate', metrics.continuationRate, 'no run with compaction on'));
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
  lines.push(`unclassifiedCompactions ${report.unclassifiedCompactions}`);
  return lines.join('\n');
};

const count = { type: 'integer', minimum: 0 } as const;
const rate = { type: 'number', minimum: 0 } as const;

const closed = (properties: Record<string, unknown>, required: readonly string[]) => ({ type: 'object', properties, required, additionalProperties: false }) as const;

const proportionSchema = closed({ successes: count, trials: count, rate, low: rate, high: rate }, ['successes', 'trials', 'rate', 'low', 'high']);

const CONTEXT_REPORT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  ...closed(
    {
      format: { const: CONTEXT_REPORT_FORMAT },
      dataset: { type: 'string', minLength: 1 },
      model: { enum: [...CONTEXT_MODELS] },
      metrics: closed(
        {
          continuationRate: proportionSchema,
          contrastiveFailures: closed({ count, n: count }, ['count', 'n']),
          lossSignalsPerCompaction: closed({ value: rate, signals: count, compactions: count, n: count }, ['value', 'signals', 'compactions', 'n']),
          fabricationRate: proportionSchema,
          identifierRetention: proportionSchema,
          governanceFidelity: proportionSchema,
          governanceConsistency: proportionSchema,
          governanceMinimality: proportionSchema,
          memoryStaleRate: proportionSchema,
          retrievalPrecision: proportionSchema,
          retrievalRecall: proportionSchema,
          tokensPerSuccess: closed({ value: rate, tokens: count, successes: count, n: count }, ['value', 'tokens', 'successes', 'n']),
        },
        ['contrastiveFailures'],
      ),
      meaningless: { type: 'array', items: { enum: [...MODEL_DEPENDENT_METRICS] } },
      unclassifiedCompactions: count,
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
          },
          ['id', 'scenario', 'compaction', 'runs', 'passedRuns', 'passed', 'passRate', 'minPassRate', 'meetsMinimum', 'totalTokens', 'compactions', 'lossSignals'],
        ),
      },
      passed: { type: 'boolean' },
    },
    ['format', 'dataset', 'model', 'metrics', 'meaningless', 'unclassifiedCompactions', 'cases', 'passed'],
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
