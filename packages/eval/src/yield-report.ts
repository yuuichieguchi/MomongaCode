import { canonicalJson } from '@momonga/foundation';
import { escapeTerminalLine, modelKindOf } from '@momonga/protocol';
import type { ModelKind, ReflectionJobState, RunStatus, Stored } from '@momonga/protocol';
import { MINIMUM_PAIRS, pairedBootstrap } from './bootstrap.ts';
import type { BootstrapInterval } from './bootstrap.ts';
import { NO_MEASURE, answerProblemsOf, describeInterval, gateLines, passRateCheck, primaryCheck, primaryNumeratorOf, tokenPrimaryOf } from './context-compare.ts';
import type { PairWords, PrimaryMeasure, PrimarySide, TokenPrimaryMetric } from './context-compare.ts';
import { compactionFactsOf, recalledOf } from './context-metrics.ts';
import type { PolicyOverlay } from './context-policy.ts';
import type { QualityCell } from './context-quality.ts';
import { uniqueAnswerers } from './context-report.ts';
import { grade } from './graders.ts';
import { eventsOfType } from './observe.ts';
import { describeProportion, proportionOrUndefined } from './report.ts';
import { EvalError } from './runner.ts';
import type { Proportion } from './stats.ts';
import { caseTotalsOf, tokenFactsOf, tokenMetricsOf, uncachedInputOfCalls } from './token-metrics.ts';
import type { CaseTokenTotals, RatioMetric } from './token-metrics.ts';
import type { Answerer, Transcript } from './transcript.ts';
import { yieldDatasetDigestOf } from './yield-dataset.ts';
import type { YieldDataset, YieldFamily } from './yield-dataset.ts';
import { YIELD_ARMS } from './yield-run.ts';
import type { YieldArm, YieldFamilyRun } from './yield-run.ts';

export const YIELD_REPORT_KIND = 'momonga.eval.yield/1';

export const YIELD_ACCEPTANCE = 'dataset-anchors';

const IF_ACCEPTED = 'if accepted by the dataset anchors';

export type YieldArmReport = {
  runId: string;
  passed: boolean;
  stopped?: string;
  tokens: CaseTokenTotals;
  costPerSuccess?: number;
  uncachedInputPerSuccess?: number;
  callsPerSuccess?: number;
  memoryStaleRate?: QualityCell;
  fabricationRate: QualityCell;
};

export type YieldReflection = {
  state: 'none' | Stored<ReflectionJobState>;
  reason?: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost?: number;
  uncachedInputTokens?: number;
};

export type YieldFamilyReport = {
  id: string;
  learn: { runId: string; status: RunStatus; reflection: YieldReflection; candidates: number; accepted: number; rejected: number };
  reuse: Record<YieldArm, YieldArmReport>;
  nothingAccepted: boolean;
  saving?: number;
  breakEvenReuses?: number;
  recalledAccepted: number;
  contributed: number;
};

export type YieldArmMetrics = {
  passRate: Proportion;
  costPerSuccess?: RatioMetric;
  uncachedInputPerSuccess?: RatioMetric;
  callsPerSuccess?: RatioMetric;
  memoryStaleRate?: QualityCell;
  fabricationRate: QualityCell;
};

export type YieldReport = {
  kind: typeof YIELD_REPORT_KIND;
  acceptance: typeof YIELD_ACCEPTANCE;
  dataset: string;
  datasetDigest: string;
  model: ModelKind;
  answeredBy: Answerer[];
  unrecordedAnswers: number;
  models: string[];
  policy: PolicyOverlay;
  codeDigest: string;
  primaryMetric: TokenPrimaryMetric;
  metrics: Record<YieldArm, YieldArmMetrics>;
  saving?: BootstrapInterval;
  breakEvenReuses?: number;
  families: YieldFamilyReport[];
  gate?: YieldGate;
};

const ARM_WORDS: PairWords = { baseline: 'without arm', candidate: 'with arm', unit: 'family', both: 'both arms', either: 'either arm' };

const totalOf = (values: readonly (number | undefined)[]): number | undefined =>
  values.reduce<number | undefined>((sum, value) => (sum === undefined || value === undefined ? undefined : sum + value), 0);

const sumCells = (cells: readonly QualityCell[]): QualityCell => ({
  numerator: cells.reduce((sum, cell) => sum + cell.numerator, 0),
  denominator: cells.reduce((sum, cell) => sum + cell.denominator, 0),
});

const armReportOf = (family: YieldFamily, transcript: Transcript, arm: YieldArm): YieldArmReport => {
  const runs = [transcript.events, ...transcript.children.map((child) => child.events)];
  const passed = transcript.stopped === undefined && grade(family.reuse.graders, transcript).passed;
  const tokens = caseTotalsOf([tokenFactsOf(runs, { state: 'none' })]);
  const recalled = recalledOf(transcript.events);
  const compactions = runs.map((events) => compactionFactsOf(events));
  const uncached = primaryNumeratorOf('uncachedInputPerSuccess', { tokens, passedRuns: 1 });
  return {
    runId: transcript.run.id,
    passed,
    ...(transcript.stopped === undefined ? {} : { stopped: transcript.stopped }),
    tokens,
    ...(passed && tokens.cost !== undefined ? { costPerSuccess: tokens.cost } : {}),
    ...(passed && uncached !== undefined ? { uncachedInputPerSuccess: uncached } : {}),
    ...(passed ? { callsPerSuccess: tokens.calls } : {}),
    ...(arm === 'with' ? { memoryStaleRate: { numerator: recalled.stale, denominator: recalled.recalled } } : {}),
    fabricationRate: sumCells(compactions.map((facts) => ({ numerator: facts.fabricatedSummaries, denominator: facts.modelSummaries }))),
  };
};

const reflectionOf = (transcript: Transcript): YieldReflection => {
  const { reflection } = transcript;
  if (reflection === undefined) throw new EvalError(`the learn session ${transcript.caseId} records no reflection, so what it proposed and what it cost are unknown`);
  const charges = reflection.charges ?? [];
  const { calls } = tokenFactsOf([], reflection);
  const cost = totalOf(calls.map((call) => call.cost));
  const uncached = uncachedInputOfCalls(calls);
  return {
    state: reflection.state,
    ...(reflection.reason === undefined ? {} : { reason: reflection.reason }),
    calls: charges.length,
    inputTokens: charges.reduce((sum, charge) => sum + charge.inputTokens, 0),
    outputTokens: charges.reduce((sum, charge) => sum + charge.outputTokens, 0),
    ...(cost === undefined ? {} : { cost }),
    ...(uncached === undefined ? {} : { uncachedInputTokens: uncached }),
  };
};

const recallOf = (run: YieldFamilyRun): Pick<YieldFamilyReport, 'recalledAccepted' | 'contributed'> => {
  if (run.with === undefined) return { recalledAccepted: 0, contributed: 0 };
  const { transcript, seeded } = run.with;
  const loaded = new Set(eventsOfType(transcript.events, 'context.memories_loaded').flatMap((event) => event.memories.map((memory) => memory.id)));
  const recalled = seeded.filter((id) => loaded.has(id));
  const contributing = new Set(
    eventsOfType(transcript.events, 'context.contribution').flatMap((event) => event.items.filter((item) => item.kind === 'memory' && item.contributed).map((item) => item.id)),
  );
  return { recalledAccepted: recalled.length, contributed: recalled.filter((id) => contributing.has(id)).length };
};

type Unsaved = Omit<YieldFamilyReport, 'saving' | 'breakEvenReuses'>;

const familyOf = (family: YieldFamily, run: YieldFamilyRun): Unsaved => {
  const without = armReportOf(family, run.without, 'without');
  return {
    id: family.id,
    learn: {
      runId: run.learn.run.id,
      status: run.learn.run.status,
      reflection: reflectionOf(run.learn),
      candidates: run.candidates.length,
      accepted: run.accepted.length,
      rejected: run.candidates.length - run.accepted.length,
    },
    reuse: { without, with: run.with === undefined ? without : armReportOf(family, run.with.transcript, 'with') },
    nothingAccepted: run.with === undefined,
    ...recallOf(run),
  };
};

const armMetricsOf = (families: readonly Unsaved[], arm: YieldArm, seed: number): YieldArmMetrics => {
  const arms = families.map((family) => family.reuse[arm]);
  const passRate = proportionOrUndefined(arms.filter((entry) => entry.passed).length, arms.length);
  if (passRate === undefined) throw new EvalError('a yield report needs at least one family');
  const { costPerSuccess, uncachedInputPerSuccess, callsPerSuccess } = tokenMetricsOf(
    arms.map((entry) => ({ totals: entry.tokens, passedRuns: entry.passed ? 1 : 0, facts: [] })),
    seed,
  );
  return {
    passRate,
    ...(costPerSuccess === undefined ? {} : { costPerSuccess }),
    ...(uncachedInputPerSuccess === undefined ? {} : { uncachedInputPerSuccess }),
    ...(callsPerSuccess === undefined ? {} : { callsPerSuccess }),
    ...(arm === 'with' ? { memoryStaleRate: sumCells(arms.flatMap((entry) => (entry.memoryStaleRate === undefined ? [] : [entry.memoryStaleRate]))) } : {}),
    fabricationRate: sumCells(arms.map((entry) => entry.fabricationRate)),
  };
};

type Measured = { metrics: Record<YieldArm, YieldArmMetrics>; families: readonly Pick<YieldFamilyReport, 'reuse'>[] };

const sideOf = (measured: Measured, arm: YieldArm): PrimarySide => ({
  metrics: measured.metrics[arm],
  cases: measured.families.map((family) => ({ tokens: family.reuse[arm].tokens, passedRuns: family.reuse[arm].passed ? 1 : 0 })),
});

const primaryOf = (measured: Measured, seed: number): PrimaryMeasure => {
  const without = sideOf(measured, 'without');
  const withArm = sideOf(measured, 'with');
  const pairs = without.cases.flatMap((baseline, index) => {
    const candidate = withArm.cases[index];
    return candidate === undefined ? [] : [{ baseline, candidate }];
  });
  return tokenPrimaryOf(without, withArm, pairs, seed, ARM_WORDS);
};

const chargeOf = (metric: TokenPrimaryMetric, reflection: YieldReflection): number | undefined => (metric === 'costPerSuccess' ? reflection.cost : reflection.uncachedInputTokens);

const savingOf = (metric: TokenPrimaryMetric, family: Unsaved): number | undefined => {
  if (family.nothingAccepted) return 0;
  const { without, with: withArm } = family.reuse;
  const before = primaryNumeratorOf(metric, { tokens: without.tokens, passedRuns: 1 });
  const after = primaryNumeratorOf(metric, { tokens: withArm.tokens, passedRuns: 1 });
  return without.passed && withArm.passed && before !== undefined && after !== undefined ? before - after : undefined;
};

const breakEvenOf = (charge: number | undefined, saving: number | undefined): number | undefined => (charge === undefined || saving === undefined || !(saving > 0) ? undefined : charge / saving);

const withSaving = (metric: TokenPrimaryMetric, family: Unsaved): YieldFamilyReport => {
  const saving = savingOf(metric, family);
  const breakEvenReuses = breakEvenOf(chargeOf(metric, family.learn.reflection), saving);
  return { ...family, ...(saving === undefined ? {} : { saving }), ...(breakEvenReuses === undefined ? {} : { breakEvenReuses }) };
};

const identityOf = (transcripts: readonly Transcript[]): { policy: PolicyOverlay; codeDigest: string } => {
  const [first] = transcripts;
  if (first === undefined || first.policy === null || first.codeDigest === null) throw new EvalError('a yield report needs sessions that record their policy and their code digest');
  const { policy, codeDigest } = first;
  const same = transcripts.every((transcript) => canonicalJson(transcript.policy) === canonicalJson(policy) && transcript.codeDigest === codeDigest);
  if (!same) throw new EvalError('the sessions of the yield run record more than one policy or code digest, so they do not measure one run configuration');
  return { policy, codeDigest };
};

export type BuildYieldReportInput = { dataset: YieldDataset; runs: readonly YieldFamilyRun[]; seed: number };

export const buildYieldReport = (input: BuildYieldReportInput): YieldReport => {
  const unsaved = input.dataset.families.map((family) => {
    const run = input.runs.find((candidate) => candidate.familyId === family.id);
    if (run === undefined) throw new EvalError(`family ${family.id} has no recorded sessions`);
    return familyOf(family, run);
  });
  const metrics = { without: armMetricsOf(unsaved, 'without', input.seed), with: armMetricsOf(unsaved, 'with', input.seed) };
  const primary = primaryOf({ metrics, families: unsaved }, input.seed);
  const families = unsaved.map((family) => withSaving(primary.metric, family));
  const transcripts = input.runs.flatMap((run) => [run.learn, run.without, ...(run.with === undefined ? [] : [run.with.transcript])]);
  const answeredBy = uniqueAnswerers(transcripts.flatMap((transcript) => transcript.answeredBy ?? []));
  const unrecordedAnswers = transcripts.filter((transcript) => transcript.answeredBy === undefined).length;
  const { interval } = primary;
  const breakEvenReuses = breakEvenOf(totalOf(families.map((family) => chargeOf(primary.metric, family.learn.reflection))), totalOf(families.map((family) => family.saving)));
  return {
    kind: YIELD_REPORT_KIND,
    acceptance: YIELD_ACCEPTANCE,
    dataset: input.dataset.name,
    datasetDigest: yieldDatasetDigestOf(input.dataset),
    model: modelKindOf(answeredBy, unrecordedAnswers),
    answeredBy,
    unrecordedAnswers,
    models: [...new Set(transcripts.flatMap((transcript) => (transcript.run.model === undefined ? [] : [transcript.run.model])))].sort(),
    ...identityOf(transcripts),
    primaryMetric: primary.metric,
    metrics,
    ...(interval === undefined ? {} : { saving: { mean: -interval.mean, low: -interval.high, high: -interval.low, n: interval.n } }),
    ...(breakEvenReuses === undefined ? {} : { breakEvenReuses }),
    families,
  };
};

export const YIELD_CHECKS = ['real_model', 'passRate', 'primary', 'memoryStaleRate', 'fabricationRate', 'measuredPairs'] as const;

export type YieldCheckName = Exclude<(typeof YIELD_CHECKS)[number], 'primary'> | TokenPrimaryMetric;

export type YieldCheck = { name: YieldCheckName; passed: boolean; detail: string };

export type YieldGate = { passed: boolean; checks: YieldCheck[] };

const realModelCheck = (report: YieldReport): YieldCheck => {
  const problems = answerProblemsOf('yield run', report);
  return {
    name: 'real_model',
    passed: problems.length === 0,
    detail: problems.length === 0 ? `every session was answered by a model, declared by the pinned provenance of the models (${report.models.join(', ')})` : problems.join('; '),
  };
};

const rateOf = (cell: QualityCell): number => (cell.denominator === 0 ? 0 : cell.numerator / cell.denominator);

const staleCheck = (report: YieldReport, seed: number): YieldCheck => {
  const name = 'memoryStaleRate';
  const rates = report.families.flatMap((family) => {
    const cell = family.reuse.with.memoryStaleRate;
    return cell === undefined || cell.denominator === 0 ? [] : [cell.numerator / cell.denominator];
  });
  if (rates.length < MINIMUM_PAIRS) {
    return { name, passed: false, detail: `${NO_MEASURE}: the with arm recalled a memory in ${rates.length} of ${report.families.length} families, so the stale share of recalled memories is measured in ${rates.length}, and ${MINIMUM_PAIRS} are needed for a real interval` };
  }
  const interval = pairedBootstrap(rates, { seed });
  return { name, passed: !(interval.low > 0), detail: `stale share of the memories the with arm recalled ${describeInterval(interval, 3)}; it fails only when the whole interval lies above 0` };
};

const noWorseCheck = (name: 'fabricationRate', what: string, report: YieldReport, seed: number): YieldCheck => {
  const differences = report.families.map((family) => rateOf(family.reuse.with[name]) - rateOf(family.reuse.without[name]));
  if (differences.length < MINIMUM_PAIRS) {
    return { name, passed: false, detail: `${NO_MEASURE}: ${differences.length} families measure ${name}, and ${MINIMUM_PAIRS} are needed for a real interval` };
  }
  const interval = pairedBootstrap(differences, { seed });
  return {
    name,
    passed: !(interval.low > 0),
    detail: `paired difference ${describeInterval(interval, 3)}; a reuse session with ${what} has the rate 0, which is what it measured; the with arm is worse only when the whole interval lies above 0`,
  };
};

const measuredPairsCheck = (report: YieldReport): YieldCheck => {
  const numerator = (arm: YieldArmReport): number | undefined => primaryNumeratorOf(report.primaryMetric, { tokens: arm.tokens, passedRuns: 1 });
  const measured = report.families.filter((family) => numerator(family.reuse.without) !== undefined && numerator(family.reuse.with) !== undefined).length;
  const name = 'measuredPairs';
  if (measured < MINIMUM_PAIRS) {
    return { name, passed: false, detail: `${NO_MEASURE}: ${measured} of ${report.families.length} families hold a pair that measures ${report.primaryMetric}, and ${MINIMUM_PAIRS} are needed for a real interval` };
  }
  return { name, passed: true, detail: `${measured} of ${report.families.length} families hold a pair that measures ${report.primaryMetric}; ${MINIMUM_PAIRS} are needed` };
};

export const judgeYield = (report: YieldReport, options: { seed: number }): YieldGate => {
  const { seed } = options;
  const pairCount = report.families.length;
  const passRate = pairCount === 0 ? undefined : pairedBootstrap(report.families.map((family) => Number(family.reuse.with.passed) - Number(family.reuse.without.passed)), { seed });
  const checks: YieldCheck[] = [
    realModelCheck(report),
    passRateCheck(pairCount, passRate, ARM_WORDS),
    primaryCheck(pairCount, primaryOf(report, seed), ARM_WORDS),
    staleCheck(report, seed),
    noWorseCheck('fabricationRate', 'no summary the model produced', report, seed),
    measuredPairsCheck(report),
  ];
  return { passed: checks.every((check) => check.passed), checks };
};

const digitsOf = (metric: TokenPrimaryMetric): number => (metric === 'costPerSuccess' ? 6 : 1);

const numberOr = (value: number | undefined, digits: number): string => (value === undefined ? 'n/a' : value.toFixed(digits));

const armLine = (report: YieldReport, arm: YieldArm): string => {
  const metrics = report.metrics[arm];
  return `${arm}: pass rate ${describeProportion(metrics.passRate)}, ${report.primaryMetric} ${numberOr(metrics[report.primaryMetric]?.value, digitsOf(report.primaryMetric))}, callsPerSuccess ${numberOr(metrics.callsPerSuccess?.value, 3)}, ${metrics.memoryStaleRate === undefined ? '' : `stale recalled memories ${metrics.memoryStaleRate.numerator}/${metrics.memoryStaleRate.denominator}, `}fabricated summaries ${metrics.fabricationRate.numerator}/${metrics.fabricationRate.denominator}`;
};

const familyLine = (report: YieldReport, family: YieldFamilyReport): string => {
  const digits = digitsOf(report.primaryMetric);
  const { reflection } = family.learn;
  const charge = `reflection ${reflection.state}${reflection.reason === undefined ? '' : ` (${reflection.reason})`}: ${reflection.calls} call(s), ${reflection.inputTokens} input, ${reflection.outputTokens} output, cost ${numberOr(reflection.cost, 6)}`;
  const accepted = `${family.learn.accepted} of ${family.learn.candidates} candidate(s) accepted, ${family.learn.rejected} rejected`;
  const arms = family.nothingAccepted
    ? 'nothing accepted, so the without session stands for both arms'
    : `recalled ${family.recalledAccepted} of the accepted, ${family.contributed} contributed; without ${family.reuse.without.passed ? 'passed' : 'failed'}, with ${family.reuse.with.passed ? 'passed' : 'failed'}`;
  return `  family ${family.id} (${IF_ACCEPTED}): ${accepted}; ${arms}; saving ${numberOr(family.saving, digits)} beside the charge of its reflection (${charge}), breakEvenReuses ${numberOr(family.breakEvenReuses, 2)}`;
};

export const formatYieldReport = (report: YieldReport, gate: YieldGate): string => {
  const digits = digitsOf(report.primaryMetric);
  const nothing = report.families.filter((family) => family.nothingAccepted).map((family) => family.id);
  return [
    `dataset ${report.dataset}: reflection yield, ${IF_ACCEPTED} (a candidate of the learn session counts as accepted exactly when its text holds an anchor of its family)`,
    `model: ${report.model} (the models the sessions used: ${report.models.length === 0 ? 'none recorded' : report.models.join(', ')})`,
    ...YIELD_ARMS.map((arm) => armLine(report, arm)),
    ...report.families.map((family) => familyLine(report, family)),
    `nothingAccepted (${IF_ACCEPTED}): ${nothing.length === 0 ? 'none' : nothing.join(', ')}`,
    `saving in ${report.primaryMetric} (${IF_ACCEPTED}; without minus with, the reflection charge not subtracted): ${
      report.saving === undefined ? 'n/a (no measure)' : `paired difference ${describeInterval(report.saving, digits)}`
    }`,
    `breakEvenReuses (${IF_ACCEPTED}): ${
      report.breakEvenReuses === undefined ? 'n/a (the saving is not above 0, or the charge or the saving is not measured)' : `reflection pays back after ${report.breakEvenReuses.toFixed(2)} later session(s) that reuse the fact`
    }`,
    ...gateLines({ gate }),
  ]
    .map(escapeTerminalLine)
    .join('\n');
};

export const encodeYieldReport = (report: YieldReport): string => `${JSON.stringify(report, null, 2)}\n`;
