import { describe, expect, it } from 'vitest';
import { CONTEXT_DATASET_FORMAT, EvalError, compareContextReports, formatContextComparison, parseContextDataset } from '@momonga/eval';
import type { Transcript } from '@momonga/eval';
import type { RunEventPayload } from '@momonga/protocol';
import { tokenFactsOf } from '../src/token-metrics.ts';
import { publicEventsOf } from './fixtures.ts';
import { contextCase, recorded } from './context-fixtures.ts';
import { buildReportAs } from './answered-fixtures.ts';

const SCENARIOS = ['a', 'b', 'c', 'd'] as const;
const CASE_IDS = SCENARIOS.flatMap((scenario) => [`${scenario}-on`, `${scenario}-off`]);
const MAIN_CODE = 'a'.repeat(64);
const HEAD_CODE = 'b'.repeat(64);

const dataset = parseContextDataset(
  JSON.stringify({
    format: CONTEXT_DATASET_FORMAT,
    name: 'tokens',
    cases: SCENARIOS.flatMap((scenario) => [contextCase(`${scenario}-on`, scenario, 'on'), contextCase(`${scenario}-off`, scenario, 'off')]),
  }),
  'tokens.json',
);

const modelCall = (): RunEventPayload =>
  ({
    type: 'model.responded',
    step: 1,
    attempt: 1,
    response: {
      status: 'completed',
      output: [],
      usage: { input_tokens: 1000, output_tokens: 50, total_tokens: 1050, input_tokens_details: { cached_tokens: 400 }, output_tokens_details: { reasoning_tokens: 0 } },
      momonga: { cost: { amount: 0.002, currency: 'USD', priceVersion: '2026-01-01' } },
      timing: { firstEventMs: 10, durationMs: 100 },
    },
  }) as unknown as RunEventPayload;

const charge = (purpose: string): RunEventPayload =>
  ({
    type: 'usage.charged',
    purpose,
    inputTokens: 300,
    outputTokens: 20,
    totalTokens: 320,
    cachedInputTokens: 100,
    cost: { amount: 0.001, currency: 'USD', priceVersion: '2026-01-01' },
    timing: { durationMs: 50 },
  }) as unknown as RunEventPayload;

const reflectionCharge = {
  id: 1,
  purpose: 'reflection' as const,
  runId: 'run-x',
  project: '/work',
  model: 'm',
  inputTokens: 500,
  outputTokens: 40,
  totalTokens: 540,
  createdAt: 1,
  detail: { cachedInputTokens: 100, cost: { amount: 0.003, currency: 'USD' as const, priceVersion: '2026-01-01' }, timing: { durationMs: 70 } },
};

const DONE_WITH_CHARGE: Transcript['reflection'] = { state: 'done', charges: [reflectionCharge] };
const DONE_WITHOUT_CHARGE: Transcript['reflection'] = { state: 'done' };

const reportOf = (reflection: Transcript['reflection'], codeDigest = MAIN_CODE, extra: readonly RunEventPayload[] = []) =>
  buildReportAs({
    dataset,
    transcripts: CASE_IDS.map((caseId) => ({ ...recorded(caseId, 0, [modelCall(), ...extra], { reflection }), codeDigest })),
    model: 'real',
    seed: 1,
  });

describe('each call is tagged with its kind (design core-on 3.4 Part A, test 12)', () => {
  it('tags a model response run, a usage charge with its purpose from USAGE_CHARGE_PURPOSES, and a reflection charge reflection', () => {
    const facts = tokenFactsOf([publicEventsOf([modelCall(), charge('compaction'), charge('permission_classifier'), charge('rejected_answer')])], DONE_WITH_CHARGE);
    expect(facts.calls.map((call) => (call as { kind?: unknown }).kind)).toEqual(['run', 'compaction', 'permission_classifier', 'rejected_answer', 'reflection']);
  });

  it('counts a rejected answer and a classifier call in the primary figures and leaves the reflection out', () => {
    const metrics = reportOf(DONE_WITH_CHARGE, MAIN_CODE, [charge('rejected_answer'), charge('permission_classifier')]).metrics;
    expect(metrics.callsPerSuccess?.value).toBeCloseTo(3, 12);
    expect(metrics.costPerSuccess?.value).toBeCloseTo(0.004, 12);
    expect(metrics.uncachedInputPerSuccess?.value).toBeCloseTo(600 + 2 * 200, 9);
  });

  it('refuses a usage charge whose purpose is outside the known kinds when the report is built', () => {
    expect(() => reportOf(DONE_WITHOUT_CHARGE, MAIN_CODE, [charge('mystery')])).toThrow(EvalError);
    expect(() => reportOf(DONE_WITHOUT_CHARGE, MAIN_CODE, [charge('mystery')])).toThrow(/mystery/);
  });
});

describe('the primary figures leave reflection out and the column holds it (design core-on 3.4 Part A, test 12)', () => {
  it('sums the primary figures over the run calls only', () => {
    const metrics = reportOf(DONE_WITH_CHARGE).metrics;
    expect(metrics.costPerSuccess?.value).toBeCloseTo(0.002, 12);
    expect(metrics.uncachedInputPerSuccess?.value).toBeCloseTo(600, 9);
    expect(metrics.callsPerSuccess?.value).toBeCloseTo(1, 12);
    expect(metrics.latencyPerSuccess?.value).toBeCloseTo(100, 9);
  });

  it('puts the reflection call in the column of each case and in the report-level reflection figures', () => {
    const report = reportOf(DONE_WITH_CHARGE);
    const tokens = report.cases[0]?.tokens as { reflection?: unknown } | undefined;
    const metrics = report.metrics as unknown as Record<string, { value: number } | undefined>;
    expect(tokens?.reflection).toEqual({ calls: 1, inputTokens: 500, cost: 0.003, settled: true });
    expect(metrics['reflectionCostPerSuccess']?.value).toBeCloseTo(0.003, 12);
    expect(metrics['reflectionCallsPerSuccess']?.value).toBeCloseTo(1, 12);
  });

  it('reports the whole bill as costPerSuccessAll, equal to the cost per success that counted every call', () => {
    const metrics = reportOf(DONE_WITH_CHARGE).metrics as unknown as Record<string, { value: number } | undefined>;
    expect(metrics['costPerSuccessAll']?.value).toBeCloseTo(0.005, 12);
  });

  it('leaves the column unmeasured and the primary figures measured while a reflection is unsettled', () => {
    for (const state of ['pending', 'running'] as const) {
      const report = reportOf({ state });
      const tokens = report.cases[0]?.tokens as { reflection?: { settled?: boolean; cost?: number } } | undefined;
      const metrics = report.metrics as unknown as Record<string, { value: number } | undefined>;
      expect(report.metrics.costPerSuccess?.value).toBeCloseTo(0.002, 12);
      expect(report.metrics.callsPerSuccess?.value).toBeCloseTo(1, 12);
      expect(tokens?.reflection?.settled).toBe(false);
      expect(tokens?.reflection?.cost).toBeUndefined();
      expect(metrics['reflectionCostPerSuccess']).toBeUndefined();
    }
  });
});

describe('the token gate primary metric excludes reflection (design core-on 3.4 Part A, test 13)', () => {
  it('finds no difference in the primary metric when the candidate differs only by reflection calls, and prints the column', () => {
    const comparison = compareContextReports(reportOf(DONE_WITHOUT_CHARGE, MAIN_CODE), reportOf(DONE_WITH_CHARGE, HEAD_CODE), { seed: 1, gate: 'token' });
    expect(comparison.differences.primary?.metric).toBe('costPerSuccess');
    expect(comparison.differences.primary?.interval?.mean).toBeCloseTo(0, 12);
    expect(formatContextComparison(comparison)).toMatch(/reflection[^\n]*0\.003/);
  });
});
