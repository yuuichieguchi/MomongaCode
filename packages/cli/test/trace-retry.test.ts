import { describe, expect, it } from 'vitest';
import { MOMONGA_ATTRIBUTES } from '@momonga/protocol';
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

describe('momonga trace shows a retried call (DECISION-12)', () => {
  it('a call the gateway sent again names the recorded call it retries', () => {
    const text = renderTrace(
      view([
        span({ spanId: 'a', name: 'chat m', attributes: { [MOMONGA_ATTRIBUTES.target]: 'metered', [MOMONGA_ATTRIBUTES.attempt]: 1 } }),
        span({ spanId: 'b', name: 'chat m', startMs: 11, endMs: 20, attributes: { [MOMONGA_ATTRIBUTES.target]: 'metered', [MOMONGA_ATTRIBUTES.attempt]: 1, [MOMONGA_ATTRIBUTES.retryOf]: 41 } }),
      ]),
    );
    expect(text).toContain('chat m  10 ms  OK  target metered, attempt 1\n');
    expect(text).toContain('chat m  9 ms  OK  target metered, attempt 1, retry of recorded call 41');
  });
});
