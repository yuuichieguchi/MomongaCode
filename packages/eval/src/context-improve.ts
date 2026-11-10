import { MIN_SUMMARY_TOKENS, escapeTerminalLine, tokensForText } from '@momonga/protocol';
import type { BilledDetail } from '@momonga/protocol';
import { compareContextReports } from './context-compare.ts';
import type { ContextComparison } from './context-compare.ts';
import { contrastiveCasesOf } from './context-report.ts';
import type { ContextModel, ContextReport } from './context-report.ts';
import { analysisRequestOf, candidateRequestOf, parseGuidelineAnalysis, parseGuidelineCandidate } from './guideline-prompts.ts';
import type { GuidelineAnalysis, GuidelineCompletion, GuidelineCompletionRequest } from './guideline-prompts.ts';
import type { Transcript } from './transcript.ts';

export const GUIDELINE_CAP_REASON = 'the command reached its token cap, counting the benchmark runs and the model calls together';
export const GUIDELINE_NO_CANDIDATE_REASON = 'the token cap leaves less than one candidate run after the baseline benchmark and the analyses';

export type AdoptedGuideline = { version: number; text: string };

export type ImproveInput = {
  seed: number;
  bootstrapSeed: number;
  analysisModel: string;
  tokenCap: number;
  current: AdoptedGuideline | undefined;
  recordChars?: number;
};

export type BenchmarkResult = { report: ContextReport; transcripts: readonly Transcript[]; tokens: number };

export type TokenUsage = GuidelineCompletion['usage'];

export type ImprovePorts = {
  benchmark(guideline: string | undefined): Promise<BenchmarkResult>;
  complete(request: GuidelineCompletionRequest): Promise<GuidelineCompletion>;
  charge(usage: TokenUsage, detail: BilledDetail | undefined): void | Promise<void>;
};

export const IMPROVE_STATUSES = ['empty', 'no_analysis', 'no_winner', 'winner', 'stopped'] as const;
export type ImproveStatus = (typeof IMPROVE_STATUSES)[number];

export type SkippedScenario = { scenario: string; reason: string };

export type ImproveCandidate = {
  index: number;
  text?: string;
  skipped?: string;
  contrastiveFailures?: number;
  comparison?: ContextComparison;
};

export type ImproveWinner = { index: number; text: string; parent: number | null; contrastiveFailures: number; comparison: ContextComparison };

export type CandidateDerivation = { baselineTokens: number; analysisTokens: number; candidateRunTokens: number; affordable: number };

export type ImproveOutcome = {
  status: ImproveStatus;
  model: ContextModel;
  analysisModel: string;
  seed: number;
  candidateCount: number;
  tokenCap: number;
  derivation?: CandidateDerivation;
  current: AdoptedGuideline | undefined;
  baseline: { contrastiveFailures: number; compactedScenarios: number; tokens: number };
  contrastive: string[];
  skipped: SkippedScenario[];
  analyses: number;
  candidates: ImproveCandidate[];
  winner?: ImproveWinner;
  reason?: string;
  tokens: { benchmark: number; charged: number };
};

const UNTRUSTED_REASON = 'a run of this scenario was not made in a trusted folder, and only trusted runs may inform a guideline';

const transcriptsOf = (transcripts: readonly Transcript[], caseId: string): Transcript[] => transcripts.filter((transcript) => transcript.caseId === caseId);

const bestWinner = (candidates: readonly ImproveCandidate[], parent: number | null): ImproveWinner | undefined => {
  const passing = candidates.flatMap((candidate) =>
    candidate.text !== undefined && candidate.comparison?.gate.passed === true && candidate.contrastiveFailures !== undefined
      ? [{ index: candidate.index, text: candidate.text, contrastiveFailures: candidate.contrastiveFailures, comparison: candidate.comparison }]
      : [],
  );
  const [best] = passing.sort((a, b) => a.contrastiveFailures - b.contrastiveFailures || a.index - b.index);
  return best === undefined ? undefined : { ...best, parent };
};

export const improveGuideline = async (input: ImproveInput, ports: ImprovePorts): Promise<ImproveOutcome> => {
  const tokens = { benchmark: 0, charged: 0 };
  const reached = (): boolean => tokens.benchmark + tokens.charged >= input.tokenCap;
  const skipped: SkippedScenario[] = [];
  const candidates: ImproveCandidate[] = [];
  let analysed = 0;
  let contrastive: string[] = [];
  let baseline: ImproveOutcome['baseline'] = { contrastiveFailures: 0, compactedScenarios: 0, tokens: 0 };

  let model: ContextModel = 'unknown';
  let derivation: CandidateDerivation | undefined;

  const outcome = (status: ImproveStatus, extra: Pick<ImproveOutcome, 'winner' | 'reason'> = {}): ImproveOutcome => ({
    status,
    model,
    analysisModel: input.analysisModel,
    seed: input.seed,
    candidateCount: new Set(candidates.flatMap((candidate) => (candidate.text === undefined ? [] : [candidate.text]))).size,
    tokenCap: input.tokenCap,
    ...(derivation === undefined ? {} : { derivation }),
    current: input.current,
    baseline,
    contrastive,
    skipped,
    analyses: analysed,
    candidates,
    tokens: { ...tokens },
    ...extra,
  });

  const stopped = (): ImproveOutcome => outcome('stopped', { reason: GUIDELINE_CAP_REASON });

  const spend = async (request: GuidelineCompletionRequest): Promise<GuidelineCompletion> => {
    const completion = await ports.complete(request);
    await ports.charge(completion.usage, completion.detail);
    tokens.charged += completion.usage.totalTokens;
    return completion;
  };

  const first = await ports.benchmark(input.current?.text);
  tokens.benchmark += first.tokens;
  model = first.report.model;
  baseline = {
    contrastiveFailures: first.report.metrics.contrastiveFailures.count,
    compactedScenarios: first.report.metrics.contrastiveFailures.n,
    tokens: first.tokens,
  };

  const cases = contrastiveCasesOf(first.report).flatMap((entry) => {
    const off = transcriptsOf(first.transcripts, entry.offId);
    const on = transcriptsOf(first.transcripts, entry.onId);
    if ([...off, ...on].some((transcript) => transcript.run.origin !== 'trusted')) {
      skipped.push({ scenario: entry.scenario, reason: UNTRUSTED_REASON });
      return [];
    }
    return [{ scenario: entry.scenario, off, on }];
  });
  contrastive = cases.map((entry) => entry.scenario);
  if (cases.length === 0) return outcome('empty');
  if (reached()) return stopped();

  const analyses: { scenario: string; analysis: GuidelineAnalysis }[] = [];
  for (const entry of cases) {
    if (reached()) return stopped();
    const completion = await spend(
      analysisRequestOf({
        scenario: entry.scenario,
        off: entry.off,
        on: entry.on,
        guideline: input.current?.text,
        seed: input.seed,
        ...(input.recordChars === undefined ? {} : { recordChars: input.recordChars }),
      }),
    );
    analysed += 1;
    const parsed = parseGuidelineAnalysis(completion);
    if ('error' in parsed) skipped.push({ scenario: entry.scenario, reason: parsed.error });
    else analyses.push({ scenario: entry.scenario, analysis: parsed.analysis });
  }
  if (analyses.length === 0) return outcome('no_analysis');

  if (reached()) return stopped();
  const analysisTokens = tokens.charged;
  const candidateRunTokens = first.tokens + Math.ceil(analysisTokens / analysed);
  const affordable = Math.floor((input.tokenCap - first.tokens - analysisTokens) / candidateRunTokens);
  derivation = { baselineTokens: first.tokens, analysisTokens, candidateRunTokens, affordable };
  if (affordable < 1) return outcome('stopped', { reason: GUIDELINE_NO_CANDIDATE_REASON });

  for (let index = 0; index < affordable; index += 1) {
    if (reached()) return stopped();
    const completion = await spend(
      candidateRequestOf({
        analyses,
        guideline: input.current?.text,
        index,
        count: affordable,
        seed: input.seed,
        ...(input.recordChars === undefined ? {} : { analysisChars: input.recordChars }),
      }),
    );
    const parsed = parseGuidelineCandidate(completion);
    if ('error' in parsed) {
      candidates.push({ index, skipped: parsed.error });
      continue;
    }
    const twin = candidates.find((earlier) => earlier.text === parsed.guideline);
    if (twin !== undefined) {
      candidates.push({ index, text: parsed.guideline, skipped: `the same text as candidate ${twin.index}, which is measured once` });
      continue;
    }
    const estimated = tokensForText(parsed.guideline);
    candidates.push(
      estimated > MIN_SUMMARY_TOKENS
        ? { index, text: parsed.guideline, skipped: `the guideline is ${estimated} estimated tokens, over the ${MIN_SUMMARY_TOKENS} the summariser accepts` }
        : { index, text: parsed.guideline },
    );
  }

  for (const candidate of candidates) {
    if (candidate.text === undefined || candidate.skipped !== undefined) continue;
    if (reached()) return stopped();
    const measured = await ports.benchmark(candidate.text);
    tokens.benchmark += measured.tokens;
    candidate.contrastiveFailures = measured.report.metrics.contrastiveFailures.count;
    candidate.comparison = compareContextReports(first.report, measured.report, { seed: input.bootstrapSeed });
  }

  const winner = bestWinner(candidates, input.current?.version ?? null);
  return winner === undefined ? outcome('no_winner') : outcome('winner', { winner });
};

const linesOf = (text: string): string[] => (text === '' ? [] : text.split('\n'));

const itemAt = <T>(items: readonly T[], index: number): T => {
  const item = items[index];
  if (item === undefined) throw new RangeError(`index ${index} is outside a list of ${items.length}`);
  return item;
};

const diffLines = (before: string, after: string): string[] => {
  const a = linesOf(before);
  const b = linesOf(after);
  const width = b.length + 1;
  const common = Array.from({ length: (a.length + 1) * width }, () => 0);
  const commonAt = (i: number, j: number): number => itemAt(common, i * width + j);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      common[i * width + j] = itemAt(a, i) === itemAt(b, j) ? commonAt(i + 1, j + 1) + 1 : Math.max(commonAt(i + 1, j), commonAt(i, j + 1));
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && itemAt(a, i) === itemAt(b, j)) {
      lines.push(`  ${itemAt(a, i)}`);
      i += 1;
      j += 1;
    } else if (j >= b.length || (i < a.length && commonAt(i + 1, j) >= commonAt(i, j + 1))) {
      lines.push(`- ${itemAt(a, i)}`);
      i += 1;
    } else {
      lines.push(`+ ${itemAt(b, j)}`);
      j += 1;
    }
  }
  return lines;
};

export const guidelineDiff = (before: string, after: string): string => diffLines(before, after).map(escapeTerminalLine).join('\n');

const bodyLines = (text: string): string[] => text.split('\n').map((line) => `  ${line}`);

export const formatGuidelineText = (text: string): string => bodyLines(text).map(escapeTerminalLine).join('\n');

const candidateLines = (candidate: ImproveCandidate): string[] => {
  if (candidate.skipped !== undefined) return [`candidate ${candidate.index}: skipped: ${candidate.skipped}`];
  const { comparison } = candidate;
  if (comparison === undefined) return [`candidate ${candidate.index}: not benchmarked`];
  const failed = comparison.gate.checks.filter((check) => !check.passed);
  return [
    `candidate ${candidate.index}: contrastiveFailures ${candidate.contrastiveFailures ?? 'n/a'}`,
    `  gate: ${comparison.gate.passed ? 'PASS' : 'FAIL'}`,
    ...failed.map((check) => `    FAIL ${check.name}: ${check.detail}`),
  ];
};

const verdictLines = (outcome: ImproveOutcome): string[] => {
  switch (outcome.status) {
    case 'empty':
      return ['no contrastive case: no scenario passes without compaction and fails with it, so there is nothing to learn from and no model call was made'];
    case 'no_analysis':
      return ['no analysis could be used, so no candidate was sampled and nothing can be adopted'];
    case 'no_winner':
      return ['no candidate passed the gate, so nothing can be adopted'];
    case 'stopped':
      return [`stopped: ${outcome.reason ?? GUIDELINE_CAP_REASON}; nothing can be adopted`];
    case 'winner': {
      const { winner } = outcome;
      if (winner === undefined) throw new Error('an outcome with the status winner holds no winner');
      return [
        `winner: candidate ${winner.index} with contrastiveFailures ${winner.contrastiveFailures}`,
        'text of the winner:',
        ...bodyLines(winner.text),
        'change:',
        ...diffLines(outcome.current?.text ?? '', winner.text),
      ];
    }
  }
};

export const formatImproveOutcome = (outcome: ImproveOutcome): string => {
  const { baseline } = outcome;
  const lines = [
    `model: ${outcome.model} (derived from the pinned provenance of the models that answered the benchmark; the analysis and candidate calls used the model ${outcome.analysisModel})`,
    ...(outcome.model === 'fake' ? ['a fake model proves only that the machinery works, so no candidate can pass the gate'] : []),
    `seed ${outcome.seed}, token cap ${outcome.tokenCap}, K=${outcome.candidateCount} distinct candidates${outcome.derivation === undefined ? '' : ` (the cap affords ${outcome.derivation.affordable}: (${outcome.tokenCap} - ${outcome.derivation.baselineTokens} baseline - ${outcome.derivation.analysisTokens} analyses) / ${outcome.derivation.candidateRunTokens} per candidate run)`}`,
    `baseline: ${outcome.current === undefined ? 'no guideline in force' : `guideline version ${outcome.current.version}`}, contrastiveFailures ${baseline.contrastiveFailures} of ${baseline.compactedScenarios} scenarios, ${baseline.tokens} benchmark tokens`,
    `contrastive set: ${outcome.contrastive.length === 0 ? 'none' : outcome.contrastive.join(', ')}`,
    ...outcome.skipped.map((entry) => `skipped ${entry.scenario}: ${entry.reason}`),
    ...outcome.candidates.flatMap(candidateLines),
    ...verdictLines(outcome),
    `tokens: ${outcome.tokens.benchmark} in benchmark runs (temporary homes, not recorded as context charges) and ${outcome.tokens.charged} in analysis and candidate calls (recorded as context charges)`,
  ];
  return lines.map(escapeTerminalLine).join('\n');
};
