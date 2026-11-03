import { describe, expect, it } from 'vitest';
import {
  CONTEXT_DATASET_FORMAT,
  GATE_CHECKS,
  buildContextReport,
  compareContextReports,
  encodeContextReport,
  formatContextComparison,
  formatContextReport,
  parseContextDataset,
  parseContextReport,
} from '@momonga/eval';
import type { ContextReport, Transcript } from '@momonga/eval';
import type { RunEventPayload, TokenAnatomy } from '@momonga/protocol';
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

const ANATOMY: TokenAnatomy = {
  estimated: true,
  total: 1000,
  layers: {
    system: 200,
    tools: 300,
    instructions: 0,
    skills: 0,
    governing: 0,
    memories: 0,
    summary: 0,
    workingState: 0,
    history: { user: 500, assistant: 0, toolCalls: 0, toolOutputs: 0 },
    notices: 0,
  },
  tools: { Read: 300 },
};

type Call = { input?: number; cached?: number; cacheWrite?: number; output?: number; reasoning?: number; cost?: number | undefined; durationMs?: number };

const DEFAULT_CALL: Required<Omit<Call, 'cost'>> & { cost: number | undefined } = { input: 1000, cached: 400, cacheWrite: 100, output: 50, reasoning: 10, cost: 0.002, durationMs: 2000 };

const callEvents = (call: Call, step: number): RunEventPayload[] => {
  const filled = { ...DEFAULT_CALL, ...call };
  return [
    { type: 'model.requested', step, attempt: 1, digest: 'd'.repeat(64), body: {}, anatomy: ANATOMY } as unknown as RunEventPayload,
    {
      type: 'model.responded',
      step,
      attempt: 1,
      response: {
        status: 'completed',
        output: [],
        usage: {
          input_tokens: filled.input,
          output_tokens: filled.output,
          total_tokens: filled.input + filled.output,
          input_tokens_details: { cached_tokens: filled.cached },
          output_tokens_details: { reasoning_tokens: filled.reasoning },
        },
        momonga: {
          cacheWriteInputTokens: filled.cacheWrite,
          ...(filled.cost === undefined ? {} : { cost: { amount: filled.cost, currency: 'USD', priceVersion: '2026-01-01' } }),
        },
        timing: { firstEventMs: 100, durationMs: filled.durationMs },
      },
    } as unknown as RunEventPayload,
  ];
};

type Variant = { failing?: string[]; calls?: Record<string, Call[]>; every?: Call; model?: 'fake' | 'real'; silent?: boolean };

const transcriptsOf = ({ failing = [], calls = {}, every = {}, silent = false }: Variant): Transcript[] =>
  CASE_IDS.map((caseId) => {
    const modelCalls = silent ? [] : (calls[caseId] ?? [every]).flatMap((call, index) => callEvents({ ...every, ...call }, index + 1));
    const compaction = caseId.endsWith('-on') ? [...bash('b0', 'npm test', 'failed'), summarized(3, fidelity([], 2, 2))] : [];
    return recorded(caseId, 0, [...modelCalls, ...compaction], { status: failing.includes(caseId) ? 'FAILED' : 'COMPLETED' });
  });

const reportOf = (variant: Variant = {}): ContextReport => buildContextReport({ dataset, transcripts: transcriptsOf(variant), model: variant.model ?? 'real', seed: 1 });

const tokenGate = (baseline: ContextReport, candidate: ContextReport) => compareContextReports(baseline, candidate, { seed: 1, gate: 'token' });

const checkOf = (comparison: ReturnType<typeof tokenGate>, name: string) => comparison.gate.checks.find((check) => check.name === name);

describe('token metrics from recorded transcripts', () => {
  it('reports cost, uncached input, calls and latency per success over every run, counting the cost of failed runs', () => {
    const { metrics } = reportOf({ failing: ['a-on'] });

    expect(metrics.costPerSuccess?.value).toBeCloseTo((8 * 0.002) / 7, 12);
    expect(metrics.uncachedInputPerSuccess?.value).toBeCloseTo((8 * 500) / 7, 9);
    expect(metrics.callsPerSuccess?.value).toBeCloseTo(8 / 7, 12);
    expect(metrics.latencyPerSuccess?.value).toBeCloseTo((8 * 2000) / 7, 9);
    expect(metrics.cacheHitRatio?.value).toBeCloseTo(0.4, 12);
  });

  it('gives each per-success metric a case-level bootstrap interval with the number of cases', () => {
    const calls = Object.fromEntries(CASE_IDS.map((caseId, index) => [caseId, [{ cost: 0.001 * (index + 1) }]]));
    const cost = reportOf({ calls }).metrics.costPerSuccess;

    expect(cost?.value).toBeCloseTo(0.036 / 8, 12);
    expect(cost?.clusters).toBe(8);
    expect(cost?.low).toBeLessThan(cost?.value as number);
    expect(cost?.high).toBeGreaterThan(cost?.value as number);
  });

  it('reports the share of each layer of the recorded anatomies', () => {
    const shares = reportOf().metrics.layerShares;

    expect(shares?.['system']?.value).toBeCloseTo(0.2, 12);
    expect(shares?.['tools']?.value).toBeCloseTo(0.3, 12);
    expect(shares?.['history.user']?.value).toBeCloseTo(0.5, 12);
  });

  it('leaves cost per success unmeasured when a call carries no price, while uncached input stays measured', () => {
    const { metrics } = reportOf({ calls: { 'b-off': [{ cost: undefined }] } });

    expect(metrics.costPerSuccess).toBeUndefined();
    expect(metrics.uncachedInputPerSuccess?.value).toBeCloseTo(500, 9);
  });

  it('prints the token metrics and keeps them through a stored report', () => {
    const report = reportOf();
    const text = formatContextReport(report);

    expect(text).toMatch(/costPerSuccess 0\.002000 .*n=8/);
    expect(text).toMatch(/uncachedInputPerSuccess 500\.0 /);
    expect(text).toMatch(/cacheHitRatio 40\.0%/);
    expect(parseContextReport(encodeContextReport(report), 'stored.json')).toEqual(report);
  });
});

describe('eval compare --gate token', () => {
  const cheaper = { every: { cost: 0.001 } };

  it('passes a candidate that is cheaper in every case with nothing else worse, on the token terms only', () => {
    const comparison = tokenGate(reportOf(), reportOf(cheaper));

    expect(comparison.gate.checks.map((check) => [check.name, check.passed])).toEqual([
      ['real_model', true],
      ['passRate', true],
      ['costPerSuccess', true],
      ['lossSignalsPerCompaction', true],
      ['fabricationRate', true],
    ]);
    expect(comparison.gate.passed).toBe(true);
  });

  it('keeps the context gate exactly as it was, so there is one gate with two term sets', () => {
    const baseline = reportOf({ failing: ['a-on', 'b-on'] });
    const candidate = reportOf();
    const byDefault = compareContextReports(baseline, candidate, { seed: 1 });
    const named = compareContextReports(baseline, candidate, { seed: 1, gate: 'context' });

    expect(named.gate).toEqual(byDefault.gate);
    expect(named.gate.checks.map((check) => check.name)).toEqual([...GATE_CHECKS]);
    expect(tokenGate(baseline, candidate).gate.checks.map((check) => check.name)).toEqual(['real_model', 'passRate', 'costPerSuccess', 'lossSignalsPerCompaction', 'fabricationRate']);
  });

  it('fails a candidate whose cost is only equal, because the primary metric must drop beyond its interval', () => {
    const check = checkOf(tokenGate(reportOf(), reportOf()), 'costPerSuccess');

    expect(check?.passed).toBe(false);
    expect(check?.detail).toMatch(/paired difference/);
  });

  it('fails a cheaper candidate that passes fewer cases, paired case by case', () => {
    const comparison = tokenGate(reportOf(), reportOf({ ...cheaper, failing: ['a-on', 'b-on', 'c-off', 'd-off'] }));

    expect(checkOf(comparison, 'passRate')?.passed).toBe(false);
    expect(comparison.gate.passed).toBe(false);
  });

  it('judges uncached input per success when a call has no price, and says why', () => {
    const unpriced = { 'a-off': [{ cost: undefined }] };
    const comparison = tokenGate(reportOf({ calls: unpriced }), reportOf({ calls: unpriced, every: { cached: 700, cacheWrite: 0 } }));

    expect(comparison.gate.checks.map((check) => check.name)).toContain('uncachedInputPerSuccess');
    expect(comparison.gate.checks.map((check) => check.name)).not.toContain('costPerSuccess');
    const check = checkOf(comparison, 'uncachedInputPerSuccess');
    expect(check?.passed).toBe(true);
    expect(check?.detail).toMatch(/price/);
  });

  it('fails a term with no measure and prints why', () => {
    const comparison = tokenGate(reportOf({ silent: true }), reportOf({ silent: true }));
    const primary = comparison.gate.checks.find((check) => check.name === 'costPerSuccess' || check.name === 'uncachedInputPerSuccess');

    expect(primary?.passed).toBe(false);
    expect(primary?.detail).toMatch(/no measure: .+/);
    expect(comparison.gate.passed).toBe(false);
    expect(formatContextComparison(comparison)).toMatch(/FAIL (costPerSuccess|uncachedInputPerSuccess): no measure/);
  });

  it('fails when the candidate loses more after compaction or fabricates more, however cheap', () => {
    const lossy = reportOf({ ...cheaper });
    const losing = buildContextReport({
      dataset,
      transcripts: transcriptsOf(cheaper).map((transcript) =>
        transcript.caseId.endsWith('-on') ? recorded(transcript.caseId, 0, [...callEvents({ cost: 0.001 }, 1), ...bash('b0', 'npm test', 'failed'), summarized(3, fidelity([], 2, 2)), ...bash('b1', 'npm test', 'failed')]) : transcript,
      ),
      model: 'real',
      seed: 1,
    });

    expect(checkOf(tokenGate(reportOf(), lossy), 'lossSignalsPerCompaction')?.passed).toBe(true);
    const comparison = tokenGate(reportOf(), losing);
    expect(checkOf(comparison, 'costPerSuccess')?.passed).toBe(true);
    expect(checkOf(comparison, 'lossSignalsPerCompaction')?.passed).toBe(false);
    expect(comparison.gate.passed).toBe(false);
    const fabricating = buildContextReport({
      dataset,
      transcripts: transcriptsOf(cheaper).map((transcript) =>
        transcript.caseId.endsWith('-on') ? recorded(transcript.caseId, 0, [...callEvents({ cost: 0.001 }, 1), ...bash('b0', 'npm test', 'failed'), summarized(3, fidelity(['ghost.ts'], 2, 2))]) : transcript,
      ),
      model: 'real',
      seed: 1,
    });
    expect(checkOf(tokenGate(reportOf(), fabricating), 'costPerSuccess')?.passed).toBe(true);
    expect(checkOf(tokenGate(reportOf(), fabricating), 'fabricationRate')?.passed).toBe(false);
  });

  it('never passes a fake model', () => {
    const comparison = tokenGate(reportOf({ model: 'fake' }), reportOf({ ...cheaper, model: 'fake' }));

    expect(checkOf(comparison, 'costPerSuccess')?.passed).toBe(true);
    expect(checkOf(comparison, 'real_model')?.passed).toBe(false);
    expect(comparison.gate.passed).toBe(false);
  });
});
