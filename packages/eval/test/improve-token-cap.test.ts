import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as evaluation from '@momonga/eval';
import { CONTEXT_DATASET_FORMAT, GUIDELINE_OUTCOME_FORMAT, buildContextReport, encodeOutcomeFile, improveGuideline, outcomeFileOf, parseContextDataset, parseOutcomeFile } from '@momonga/eval';
import type { GuidelineCompletion, GuidelineCompletionRequest, ImproveInput, Transcript } from '@momonga/eval';
import { REAL_TARGET, answeredBy } from './answered-fixtures.ts';
import { bash, contextCase, fidelity, read, recorded, summarized } from './context-fixtures.ts';

const PACKAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SCENARIOS = ['a', 'b', 'c', 'd'] as const;
const BENCHMARK_TOKENS = 100;
const USAGE = { inputTokens: 7, outputTokens: 3, totalTokens: 10 };

const dataset = parseContextDataset(
  JSON.stringify({ format: CONTEXT_DATASET_FORMAT, name: 'improve', cases: SCENARIOS.flatMap((scenario) => [contextCase(`${scenario}-on`, scenario, 'on'), contextCase(`${scenario}-off`, scenario, 'off')]) }),
  'improve.json',
);

const transcriptsOf = (failingOn: readonly string[]): Transcript[] =>
  SCENARIOS.flatMap((scenario) => [
    recorded(`${scenario}-on`, 0, [...bash('b0', 'npm test', 'failed'), summarized(3, fidelity([], 2, 2))], { status: failingOn.includes(scenario) ? 'FAILED' : 'COMPLETED' }),
    recorded(`${scenario}-off`, 0, read('r0', '/p/a.ts', 'contents')),
  ]).map((transcript) => answeredBy({ ...transcript, run: { ...transcript.run, origin: 'trusted' } }, REAL_TARGET));

const measured = (failingOn: readonly string[]) => {
  const transcripts = transcriptsOf(failingOn);
  return { report: buildContextReport({ dataset, transcripts, seed: 1 } as Parameters<typeof buildContextReport>[0]), transcripts, tokens: BENCHMARK_TOKENS };
};

const analysis = (): string =>
  JSON.stringify({
    divergence_step_description: 'the summary lost the failing test',
    root_cause_categories: ['Missing Critical Fact'],
    missing_or_distorted_facts: ['test name'],
    summary_inaccuracies: [],
    lost_state_variables: ['failing test'],
    remediation_recommendations: ['keep failing test names'],
    reliability_score: 0.8,
  });

const improve = async (tokenCap: number) => {
  const requests: GuidelineCompletionRequest[] = [];
  const benchmarked: (string | undefined)[] = [];
  const input = { seed: 42, bootstrapSeed: 1, alias: 'opus', tokenCap, current: undefined } as unknown as ImproveInput;
  const outcome = await improveGuideline(input, {
    benchmark: async (guideline) => {
      benchmarked.push(guideline);
      return guideline === undefined ? measured(['a', 'b']) : measured(['a', 'b', 'c']);
    },
    complete: async (request): Promise<GuidelineCompletion> => {
      requests.push(request);
      const index = requests.filter((entry) => entry.purpose === request.purpose).length - 1;
      return { text: request.purpose === 'analysis' ? analysis() : JSON.stringify({ guideline: `candidate ${index}` }), usage: USAGE };
    },
    charge: () => undefined,
  });
  return { outcome, requests, benchmarked };
};

const candidateRequests = (requests: readonly GuidelineCompletionRequest[]) => requests.filter((request) => request.purpose !== 'analysis');

describe('K is derived from the token cap the person states', () => {
  it('K is derived from the cap and the measured baseline: a cap of 3 benchmark runs gives 1 candidate', async () => {
    const { outcome, requests, benchmarked } = await improve(3 * BENCHMARK_TOKENS);
    expect(outcome.candidateCount).toBe(1);
    expect(candidateRequests(requests)).toHaveLength(1);
    expect(benchmarked).toHaveLength(2);
    expect(outcome.status).not.toBe('stopped');
  });

  it('K is derived from the cap and the measured baseline: a cap of 7 benchmark runs gives 5 candidates', async () => {
    const { outcome, requests, benchmarked } = await improve(7 * BENCHMARK_TOKENS);
    expect(outcome.candidateCount).toBe(5);
    expect(candidateRequests(requests)).toHaveLength(5);
    expect(benchmarked).toHaveLength(6);
    expect(outcome.status).not.toBe('stopped');
    expect((outcome as unknown as { tokenCap: number }).tokenCap).toBe(700);
  });

  it('K is derived from the cap and the measured baseline: a cap of 5 benchmark runs gives 3 candidates', async () => {
    const { outcome, requests, benchmarked } = await improve(5 * BENCHMARK_TOKENS);
    expect(outcome.candidateCount).toBe(3);
    expect(candidateRequests(requests)).toHaveLength(3);
    expect(benchmarked).toHaveLength(4);
  });

  it('a cap below the baseline plus the analyses plus one candidate run stops with the reason and makes no candidate call', async () => {
    const { outcome, requests } = await improve(BENCHMARK_TOKENS + 50);
    expect(outcome.status).toBe('stopped');
    expect(outcome.reason).toMatch(/candidate/);
    expect(candidateRequests(requests)).toEqual([]);
    expect(outcome.candidateCount).toBe(0);
  });

  it('the outcome records the cap, K and the measured numbers K was derived from', async () => {
    const { outcome } = await improve(7 * BENCHMARK_TOKENS);
    const record = outcome as unknown as { tokenCap: number; candidateCount: number; derivation: { baselineTokens: number; analysisTokens: number; candidateRunTokens: number } };
    expect(record.tokenCap).toBe(700);
    expect(record.derivation.baselineTokens).toBe(BENCHMARK_TOKENS);
    expect(record.derivation.analysisTokens).toBe(2 * USAGE.totalTokens);
    expect(record.derivation.candidateRunTokens).toBeGreaterThanOrEqual(BENCHMARK_TOKENS);
    expect(Math.floor((record.tokenCap - record.derivation.baselineTokens - record.derivation.analysisTokens) / record.derivation.candidateRunTokens)).toBe(record.candidateCount);
  });

  it('the outcome file is format momonga-guideline-outcome/2 and keeps the cap and K', async () => {
    expect(GUIDELINE_OUTCOME_FORMAT).toBe('momonga-guideline-outcome/2');
    const { outcome } = await improve(3 * BENCHMARK_TOKENS);
    const file = parseOutcomeFile(encodeOutcomeFile(outcomeFileOf(outcome, { name: 'improve', digest: 'e'.repeat(64) })));
    expect(file).toMatchObject({ tokenCap: 300, candidateCount: 1 });
  });
});

describe('no constant K remains', () => {
  const sourceFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    });

  it('@momonga/eval does not export GUIDELINE_CANDIDATES', () => {
    expect(Object.keys(evaluation)).not.toContain('GUIDELINE_CANDIDATES');
  });

  it('no GUIDELINE_CANDIDATES constant remains in eval or cli', () => {
    const mentioning = ['eval/src', 'cli/src'].flatMap((directory) => sourceFiles(path.join(PACKAGES, directory))).filter((file) => readFileSync(file, 'utf8').includes('GUIDELINE_CANDIDATES'));
    expect(mentioning.map((file) => path.relative(PACKAGES, file))).toEqual([]);
  });

  it('the cap is no longer derived from K', () => {
    const command = readFileSync(path.join(PACKAGES, 'cli/src/commands/context.ts'), 'utf8');
    expect(command).not.toMatch(/datasetTokens \* \(1 \+/);
  });
});
