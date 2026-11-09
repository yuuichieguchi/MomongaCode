import { describe, expect, it } from 'vitest';
import {
  CONTEXT_DATASET_FORMAT,
  CONTEXT_REPORT_FORMAT,
  compareContextReports,
  encodeContextReport,
  formatContextReport,
  parseContextDataset,
  parseContextReport,
  uncachedInputOf,
} from '@momonga/eval';
import type { ContextReport, Transcript } from '@momonga/eval';
import type { RunEventPayload } from '@momonga/protocol';
import { bash, contextCase, fidelity, ran, recorded, summarized } from './context-fixtures.ts';
import { buildReportAs, withMeasuredQuality } from './answered-fixtures.ts';

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

type Call = { unreported?: boolean; cached?: number; cacheWrite?: number; cost?: number | undefined };

const REPORTING: Call = { cached: 400, cacheWrite: 100, cost: 0.002 };
const METERED_UNREPORTED: Call = { unreported: true, cacheWrite: 100, cost: undefined };
const LOCAL_UNREPORTED: Call = { unreported: true, cacheWrite: 0, cost: 0 };

const callEvents = (call: Call, step: number): RunEventPayload[] => [
  {
    type: 'model.responded',
    step,
    attempt: 1,
    response: {
      status: 'completed',
      output: [],
      usage: {
        input_tokens: 1000,
        output_tokens: 50,
        total_tokens: 1050,
        input_tokens_details: { cached_tokens: call.unreported === true ? 0 : (call.cached ?? 0) },
        output_tokens_details: { reasoning_tokens: 0 },
      },
      momonga: {
        cacheWriteInputTokens: call.cacheWrite ?? 0,
        ...(call.unreported === true ? { cacheReadNotReported: true } : {}),
        ...(call.cost === undefined
          ? { unpriced: { code: 'cache_read_not_reported', reason: 'the upstream did not report the cache reads of the call' } }
          : { cost: { amount: call.cost, currency: 'USD', priceVersion: '2026-01-01' } }),
      },
      timing: { firstEventMs: 100, durationMs: 2000 },
    },
  } as unknown as RunEventPayload,
];

const transcriptsOf = (callsOf: (caseId: string) => readonly Call[]): Transcript[] =>
  CASE_IDS.map((caseId) => {
    const modelCalls = callsOf(caseId).flatMap((call, index) => callEvents(call, index + 1));
    const compaction = caseId.endsWith('-on') ? [...ran(bash('b0', 'npm test', 'failed')), summarized(3, fidelity([], 2, 2))] : [];
    return recorded(caseId, 0, [...modelCalls, ...compaction]);
  });

const reportOf = (callsOf: (caseId: string) => readonly Call[]): ContextReport =>
  withMeasuredQuality(buildReportAs({ dataset, transcripts: transcriptsOf(callsOf), model: 'real', seed: 1 }));

const oneUnreported = (caseId: string): readonly Call[] => (caseId === 'a-off' ? [METERED_UNREPORTED] : [REPORTING]);
const allOf = (call: Call) => (): readonly Call[] => [call];

const tokensOf = (report: ContextReport, caseId: string) => report.cases.find((entry) => entry.id === caseId)?.tokens;

const lineOf = (report: ContextReport, metric: string): string => formatContextReport(report).split('\n').find((line) => line.startsWith(`${metric} `)) ?? '';

const tokenGate = (baseline: ContextReport, candidate: ContextReport) =>
  compareContextReports(baseline, { ...candidate, policy: { context: { cachePrefix: true } } }, { seed: 1, gate: 'token' });

const primaryOf = (comparison: ReturnType<typeof tokenGate>) =>
  comparison.gate.checks.find((check) => check.name === 'costPerSuccess' || check.name === 'uncachedInputPerSuccess');

describe('eval reads the cache-read fact, not the wire 0', () => {
  it('leaves cachedInputTokens absent for a model.responded that carries the wire 0 and cacheReadNotReported', () => {
    const report = reportOf(oneUnreported);

    expect(tokensOf(report, 'a-off')).toEqual({ calls: 1, unsettledReflections: 0, cacheReadNotReportedCalls: 1, inputTokens: 1000, latencyMs: 2000, unpriced: { cache_read_not_reported: 1 } });
  });

  it('gives a fully reporting case its sums, its reported input and a zero unreported count', () => {
    const report = reportOf(oneUnreported);

    expect(tokensOf(report, 'a-on')).toEqual({
      calls: 1,
      unsettledReflections: 0,
      cacheReadNotReportedCalls: 0,
      inputTokens: 1000,
      cacheReportedInputTokens: 1000,
      cachedInputTokens: 400,
      uncachedInputTokens: 500,
      cost: 0.002,
      latencyMs: 2000,
    });
  });

  it('sums the cache figures over the reporting calls of a mixed case and counts the rest', () => {
    const report = reportOf((caseId) => (caseId === 'b-on' ? [REPORTING, METERED_UNREPORTED] : [REPORTING]));

    expect(tokensOf(report, 'b-on')).toEqual({
      calls: 2,
      unsettledReflections: 0,
      cacheReadNotReportedCalls: 1,
      inputTokens: 2000,
      cacheReportedInputTokens: 1000,
      cachedInputTokens: 400,
      uncachedInputTokens: 500,
      latencyMs: 4000,
      unpriced: { cache_read_not_reported: 1 },
    });
  });
});

describe('cacheHitRatio is measured over the calls that reported', () => {
  it('takes the ratio over P of N calls, with no cluster from a case that reported nothing', () => {
    const ratio = reportOf(oneUnreported).metrics.cacheHitRatio;

    expect(ratio?.value).toBeCloseTo(0.4, 12);
    expect(ratio?.numerator).toBe(2800);
    expect(ratio?.denominator).toBe(7000);
    expect(ratio?.clusters).toBe(7);
  });

  it('says over how many calls it was measured and how many were not reported', () => {
    expect(lineOf(reportOf(oneUnreported), 'cacheHitRatio')).toContain('over 7 of 8 call(s), cache reads not reported in 1 call(s) of 1 case(s)');
  });

  it('is unmeasured with the "in all" cause when no call reported', () => {
    const report = reportOf(allOf(METERED_UNREPORTED));

    expect(report.metrics.cacheHitRatio).toBeUndefined();
    expect(lineOf(report, 'cacheHitRatio')).toBe('cacheHitRatio n/a (cache reads not reported in all 8 call(s))');
  });
});

describe('uncachedInputPerSuccess needs every call', () => {
  it('reads uncached input only from totals with no unreported call', () => {
    expect(uncachedInputOf({ calls: 2, unsettledReflections: 0, cacheReadNotReportedCalls: 1, inputTokens: 2000, cacheReportedInputTokens: 1000, cachedInputTokens: 400, uncachedInputTokens: 500 })).toBeUndefined();
    expect(uncachedInputOf({ calls: 1, unsettledReflections: 0, cacheReadNotReportedCalls: 0, inputTokens: 1000, cacheReportedInputTokens: 1000, cachedInputTokens: 400, uncachedInputTokens: 500 })).toBe(500);
  });

  it('is unmeasured for one unreported call and names the cause', () => {
    const report = reportOf(oneUnreported);

    expect(report.metrics.uncachedInputPerSuccess).toBeUndefined();
    expect(lineOf(report, 'uncachedInputPerSuccess')).toBe('uncachedInputPerSuccess n/a (cache reads not reported in 1 of 8 call(s))');
  });

  it('gives the "in all" cause when no call reported', () => {
    expect(lineOf(reportOf(allOf(METERED_UNREPORTED)), 'uncachedInputPerSuccess')).toBe('uncachedInputPerSuccess n/a (cache reads not reported in all 8 call(s))');
  });
});

describe('the token gate on targets that do not report cache reads', () => {
  it('fails with no measure and the cause when one call of each report is unreported', () => {
    const primary = primaryOf(tokenGate(reportOf(oneUnreported), reportOf(oneUnreported)));

    expect(primary?.name).toBe('uncachedInputPerSuccess');
    expect(primary?.passed).toBe(false);
    expect(primary?.detail).toMatch(/^no measure: /);
    expect(primary?.detail).toContain('cache reads not reported in 1 of 8 call(s)');
  });

  it('fails a metered pair that never reports with the "in all" cause', () => {
    const comparison = tokenGate(reportOf(allOf(METERED_UNREPORTED)), reportOf(allOf(METERED_UNREPORTED)));
    const primary = primaryOf(comparison);

    expect(primary?.name).toBe('uncachedInputPerSuccess');
    expect(primary?.passed).toBe(false);
    expect(primary?.detail).toMatch(/^no measure: /);
    expect(primary?.detail).toContain('cache reads not reported in all 8 call(s)');
    expect(comparison.gate.passed).toBe(false);
  });

  it('fails a local pair that never reports, priced 0, with the same cause', () => {
    const comparison = tokenGate(reportOf(allOf(LOCAL_UNREPORTED)), reportOf(allOf(LOCAL_UNREPORTED)));
    const primary = primaryOf(comparison);

    expect(primary?.name).toBe('uncachedInputPerSuccess');
    expect(primary?.passed).toBe(false);
    expect(primary?.detail).toContain('cache reads not reported in all 8 call(s)');
    expect(comparison.gate.passed).toBe(false);
  });

  it('still passes a local pair that fully reports and whose candidate sends less uncached input', () => {
    const local = (cached: number): Call => ({ cached, cacheWrite: 0, cost: 0 });
    const comparison = tokenGate(reportOf(allOf(local(400))), reportOf(allOf(local(700))));
    const primary = primaryOf(comparison);

    expect(primary?.name).toBe('uncachedInputPerSuccess');
    expect(primary?.passed).toBe(true);
  });
});

describe('the context report format records the cache-read fact', () => {
  it('is /7 and keeps a report with unreported calls through a round trip', () => {
    const report = reportOf(oneUnreported);

    expect(CONTEXT_REPORT_FORMAT).toBe('momonga-eval-context-report/7');
    expect(report.format).toBe('momonga-eval-context-report/7');
    expect(parseContextReport(encodeContextReport(report), 'stored.json')).toEqual(report);
  });

  it('refuses a /4 report as retired, with the reason', () => {
    const previous = encodeContextReport({ ...reportOf(oneUnreported), format: 'momonga-eval-context-report/4' } as unknown as ContextReport);

    expect(() => parseContextReport(previous, 'previous.json')).toThrow(
      'previous.json: momonga-eval-context-report/4 reports do not record which calls the upstream reported cache reads for (an unreported cache read was recorded as 0), so momonga-eval-context-report/4 is retired and cannot be compared as momonga-eval-context-report/7;',
    );
  });

  it('refuses a case whose tokens lack cacheReadNotReportedCalls', () => {
    const stored = JSON.parse(encodeContextReport(reportOf(oneUnreported))) as { format: string; cases: { tokens?: Record<string, unknown> }[] };
    stored.format = CONTEXT_REPORT_FORMAT;
    for (const entry of stored.cases) delete entry.tokens?.['cacheReadNotReportedCalls'];

    expect(() => parseContextReport(JSON.stringify(stored), 'stored.json')).toThrow(/stored\.json: not a context report/);
  });

  it('accepts a case with no cachedInputTokens when nothing reported', () => {
    const report = reportOf(allOf(METERED_UNREPORTED));
    const parsed = parseContextReport(encodeContextReport(report), 'stored.json');

    expect(tokensOf(parsed, 'a-on')).not.toHaveProperty('cachedInputTokens');
    expect(tokensOf(parsed, 'a-on')?.cacheReadNotReportedCalls).toBe(1);
  });
});
