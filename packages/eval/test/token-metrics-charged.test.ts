import { describe, expect, it } from 'vitest';
import { CONTEXT_DATASET_FORMAT, buildContextReport, parseContextDataset } from '@momonga/eval';
import type { Transcript } from '@momonga/eval';
import type { RunEventPayload } from '@momonga/protocol';
import { bash, contextCase, fidelity, recorded, summarized } from './context-fixtures.ts';

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

const compactionCharge = (cost: number | undefined): RunEventPayload =>
  ({
    type: 'usage.charged',
    purpose: 'compaction',
    inputTokens: 300,
    outputTokens: 20,
    totalTokens: 320,
    cachedInputTokens: 100,
    ...(cost === undefined ? {} : { cost: { amount: cost, currency: 'USD', priceVersion: '2026-01-01' } }),
  }) as unknown as RunEventPayload;

const transcripts = (charge: RunEventPayload | undefined): Transcript[] =>
  CASE_IDS.map((caseId) => {
    const compaction = caseId.endsWith('-on') ? [...bash('b0', 'npm test', 'failed'), ...(charge === undefined ? [] : [charge]), summarized(3, fidelity([], 2, 2))] : [];
    return recorded(caseId, 0, [modelCall(), ...compaction]);
  });

const reportOf = (charge: RunEventPayload | undefined) => buildContextReport({ dataset, transcripts: transcripts(charge), model: 'real', seed: 1 });

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
    expect(metrics.latencyPerSuccess).toBeUndefined();
  });
});
