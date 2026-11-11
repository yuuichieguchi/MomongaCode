import { describe, expect, it } from 'vitest';
import type { RunTraceSpan, RunTraceView } from '@momonga/protocol';
import { renderTrace } from '../src/commands/trace.ts';

const span = (overrides: Partial<RunTraceSpan> & Pick<RunTraceSpan, 'spanId' | 'name'>): RunTraceSpan => ({
  traceId: 't',
  parentSpanId: 'root',
  kind: 'CLIENT',
  startMs: 0,
  endMs: 10,
  status: 'OK',
  attributes: {},
  ...overrides,
});

const view = (spans: RunTraceSpan[]): RunTraceView => ({
  runId: 'run-1',
  summary: { steps: 1, chatCalls: spans.length, sideCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheReadNotReportedCalls: 0, errorCount: 0, durationMs: 30, chatResults: [] },
  spans: [span({ spanId: 'root', name: 'invoke_agent momonga', parentSpanId: null, kind: 'INTERNAL', endMs: 30 }), ...spans],
});


const ALLOWED_CAUSE = { target: 'plan', code: 'plan_usage_unavailable', message: 'Try again later.', fromBilling: 'plan', toBilling: 'metered', reason: 'billing_change_allowed' };

describe('momonga trace reads the fallback causes of a span through the one guard (P-S1)', () => {
  it('a span whose fallback causes are not a list of fallback causes is refused with a TypeError', () => {
    const render = (): string =>
      renderTrace(view([span({ spanId: 'b', name: 'chat m', attributes: { 'momonga.target': 'metered', 'momonga.attempt': 1, 'momonga.fallback_causes': '[{"target":1}]' } })]));
    expect(render).toThrow(TypeError);
    expect(render).toThrow('span b attribute momonga.fallback_causes must hold a list of fallback causes');
  });

  it('an allowed billing change renders as the failure and the change of billing', () => {
    const text = renderTrace(
      view([span({ spanId: 'b', name: 'chat m', attributes: { 'momonga.target': 'metered', 'momonga.attempt': 1, 'momonga.fallback_causes': JSON.stringify([ALLOWED_CAUSE]) } })]),
    );
    expect(text).toContain(
      'chat m  10 ms  OK  target metered, attempt 1, answered after plan failed (plan_usage_unavailable: Try again later.), so the request changed from plan to metered billing as models.billingChanges allows',
    );
  });
});
