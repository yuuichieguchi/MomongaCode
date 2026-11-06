import { describe, expect, it } from 'vitest';
import { CONTEXT_DATASET_FORMAT, formatContextReport, parseContextDataset } from '@momonga/eval';
import type { Transcript } from '@momonga/eval';
import type { RunEventPayload } from '@momonga/protocol';
import { bash, contextCase, fidelity, recorded, summarized } from './context-fixtures.ts';
import { buildReportAs } from './answered-fixtures.ts';

const SCENARIOS = ['a', 'b', 'c', 'd'] as const;
const CASE_IDS = SCENARIOS.flatMap((scenario) => [`${scenario}-on`, `${scenario}-off`]);

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

const compactionCharge = (cost: number | undefined, extra: Record<string, unknown> = { timing: { durationMs: 50 } }): RunEventPayload =>
  ({
    type: 'usage.charged',
    purpose: 'compaction',
    inputTokens: 300,
    outputTokens: 20,
    totalTokens: 320,
    cachedInputTokens: 100,
    ...(cost === undefined ? {} : { cost: { amount: cost, currency: 'USD', priceVersion: '2026-01-01' } }),
    ...extra,
  }) as unknown as RunEventPayload;

const transcripts = (charge: RunEventPayload | undefined, reflection?: Transcript['reflection']): Transcript[] =>
  CASE_IDS.map((caseId) => {
    const compaction = caseId.endsWith('-on') ? [...bash('b0', 'npm test', 'failed'), ...(charge === undefined ? [] : [charge]), summarized(3, fidelity([], 2, 2))] : [];
    return recorded(caseId, 0, [modelCall(), ...compaction], reflection === undefined ? {} : { reflection });
  });

const reportOf = (charge: RunEventPayload | undefined, reflection?: Transcript['reflection']) =>
  buildReportAs({ dataset, transcripts: transcripts(charge, reflection), model: 'real', seed: 1 });

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

describe('the token metrics count every billed call of a run', () => {
  it('adds the compaction calls to the cost, the uncached input and the calls per success', () => {
    const plain = reportOf(undefined).metrics;
    const charged = reportOf(compactionCharge(0.001)).metrics;

    expect(plain.costPerSuccess?.value).toBeCloseTo(0.002, 12);
    expect(charged.costPerSuccess?.value).toBeCloseTo((8 * 0.002 + 4 * 0.001) / 8, 12);
    expect(charged.uncachedInputPerSuccess?.value).toBeCloseTo((8 * 600 + 4 * 200) / 8, 9);
    expect(charged.callsPerSuccess?.value).toBeCloseTo(12 / 8, 12);
  });

  it('leaves the metric unmeasured when a charged call lacks the field it needs', () => {
    const metrics = reportOf(compactionCharge(undefined)).metrics;

    expect(metrics.costPerSuccess).toBeUndefined();
    expect(metrics.uncachedInputPerSuccess).toBeDefined();
    expect(metrics.latencyPerSuccess).toBeDefined();
  });

  it('measures latency over the compaction duration too, and leaves it unmeasured when a charge has no timing', () => {
    expect(reportOf(compactionCharge(0.001)).metrics.latencyPerSuccess?.value).toBeCloseTo((8 * 100 + 4 * 50) / 8, 9);
    expect(reportOf(compactionCharge(0.001, {})).metrics.latencyPerSuccess).toBeUndefined();
  });

  it('leaves the uncached input and the cache hit ratio unmeasured when a call reports more cached and written than it sent', () => {
    const report = reportOf(compactionCharge(0.001, { cacheWriteInputTokens: 250, timing: { durationMs: 50 } }));

    expect(report.metrics.uncachedInputPerSuccess).toBeUndefined();
    expect(report.metrics.cacheHitRatio).toBeUndefined();
    expect(report.metrics.callsPerSuccess).toBeDefined();
  });
});

describe('the token metrics count the reflection charge of a run', () => {
  it('adds a finished reflection to the cost, the uncached input, the calls and the latency', () => {
    const none = reportOf(undefined).metrics;
    const done = reportOf(undefined, { state: 'done', charges: [reflectionCharge] }).metrics;

    expect(none.callsPerSuccess?.value).toBeCloseTo(1, 12);
    expect(done.callsPerSuccess?.value).toBeCloseTo(2, 12);
    expect(done.costPerSuccess?.value).toBeCloseTo(0.005, 12);
    expect(done.uncachedInputPerSuccess?.value).toBeCloseTo(600 + 400, 9);
    expect(done.latencyPerSuccess?.value).toBeCloseTo(170, 9);
  });

  it('leaves every per-success metric unmeasured while a reflection is pending, and reports why', () => {
    for (const state of ['pending', 'running'] as const) {
      const report = reportOf(undefined, { state });
      expect(report.metrics.costPerSuccess).toBeUndefined();
      expect(report.metrics.callsPerSuccess).toBeUndefined();
      expect(report.metrics.cacheHitRatio).toBeUndefined();
      expect(report.cases[0]?.tokens?.unsettledReflections).toBe(1);
      expect(formatContextReport(report)).toContain('reflection');
    }
  });

  it('treats a run with no recorded reflection as unmeasured rather than as a run without one', () => {
    const [first, ...rest] = transcripts(undefined);
    const { reflection: _recorded, ...unrecorded } = first as Transcript;
    const report = buildReportAs({ dataset, transcripts: [unrecorded, ...rest], model: 'real', seed: 1 });

    expect(report.metrics.costPerSuccess).toBeUndefined();
    expect(report.cases.find((entry) => entry.id === unrecorded.caseId)?.tokens?.unsettledReflections).toBe(1);
  });

  it('counts a reflection that never ran as no call', () => {
    expect(reportOf(undefined, { state: 'none' }).metrics.callsPerSuccess?.value).toBeCloseTo(1, 12);
    expect(reportOf(undefined, { state: 'failed' }).metrics.callsPerSuccess?.value).toBeCloseTo(1, 12);
  });

  it('settles a finished reflection without a charge as no call, since no call is made for an untrusted folder, with reflection off, after a run that was not a verified success, or with a role alias without structured output', () => {
    const report = reportOf(undefined, { state: 'done' });
    expect(report.metrics.callsPerSuccess?.value).toBeCloseTo(1, 12);
    expect(report.cases[0]?.tokens?.unsettledReflections).toBe(0);
  });

  it('adds one call per charge of a retried reflection', () => {
    const retried = { state: 'done' as const, charges: [reflectionCharge, { ...reflectionCharge, id: 2 }] };
    const metrics = reportOf(undefined, retried).metrics;
    expect(metrics.callsPerSuccess?.value).toBeCloseTo(3, 12);
    expect(metrics.costPerSuccess?.value).toBeCloseTo(0.002 + 2 * 0.003, 12);
    expect(metrics.latencyPerSuccess?.value).toBeCloseTo(100 + 2 * 70, 9);
  });
});
