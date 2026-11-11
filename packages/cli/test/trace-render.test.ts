import { describe, expect, it } from 'vitest';
import type { RunTraceSpan, RunTraceView, UsageReport } from '@momonga/protocol';
import { renderTrace } from '../src/commands/trace.ts';
import { terminalSink } from '../src/terminal-writer.ts';

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
  summary: { steps: 1, chatCalls: spans.length - 1, sideCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheReadNotReportedCalls: 0, errorCount: 0, durationMs: 30, chatResults: [] },
  spans: [span({ spanId: 'root', name: 'invoke_agent momonga', parentSpanId: null, kind: 'INTERNAL', endMs: 30 }), ...spans],
});

const usage = { total: { input_tokens: 1, output_tokens: 1 }, responses: [] } as unknown as UsageReport;

describe('renderTrace', () => {
  it('names the target of a chat call, the target that failed and why when a fallback target answered', () => {
    const text = renderTrace(
      view([
        span({
          spanId: 'a',
          name: 'chat m',
          startMs: 1,
          endMs: 11,
          status: 'ERROR',
          attributes: { 'momonga.target': 'primary', 'momonga.attempt': 1, 'error.type': 'server_error', 'momonga.failure_message': 'primary is down' },
        }),
        span({
          spanId: 'b',
          name: 'chat m',
          startMs: 12,
          endMs: 22,
          attributes: {
            'momonga.target': 'secondary',
            'momonga.attempt': 1,
            'momonga.fallback_causes': JSON.stringify([{ target: 'primary', code: 'upstream_error', message: 'primary is down' }]),
          },
        }),
      ]),
      usage,
    );

    expect(text).toContain('chat m  10 ms  ERROR  target primary, attempt 1: server_error: primary is down');
    expect(text).toContain('chat m  10 ms  OK  target secondary, attempt 1, answered after primary failed (upstream_error: primary is down)');
  });

  it('escapes the control characters of a span name and of a failure message', () => {
    const hostile = 'x\u001b]0;pwn\u0007\u009b2J‮y';
    const text = renderTrace(
      view([span({ spanId: 'a', name: `execute_tool ${hostile}`, status: 'ERROR', attributes: { 'momonga.target': 'primary', 'momonga.failure_message': hostile } })]),
      usage,
    );

    const written: string[] = [];
    terminalSink(() => ({ write: (chunk) => void written.push(chunk) })).write(`${text}\n`);
    expect(written.join('')).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮]/u);
    expect(written.join('').split('x\\u001b]0;pwn\\u0007\\u009b2J\\u202ey').length - 1).toBe(2);
  });

  it('leaves a call answered by the first target without a fallback note', () => {
    const text = renderTrace(view([span({ spanId: 'a', name: 'chat m', attributes: { 'momonga.target': 'primary', 'momonga.attempt': 1 } })]), usage);

    expect(text).toContain('chat m  10 ms  OK  target primary, attempt 1');
    expect(text).not.toContain('answered after');
  });
});
