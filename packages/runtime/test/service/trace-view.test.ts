import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openTraceStore } from '@momonga/observability';
import type { SpanRecord } from '@momonga/observability';
import { createFakeClock, registerCleanup, withTempDir } from '@momonga/testkit';
import { runTraceOf } from '../../src/service/trace-view.ts';
import { BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';

const NO_GATEWAY_SPANS = { runSpans: async (): Promise<SpanRecord[]> => [] };
const OPEN = new AbortController().signal;

const span = (overrides: Partial<SpanRecord>): SpanRecord => ({
  traceId: 't1',
  spanId: 's1',
  parentSpanId: null,
  name: 'invoke_agent momonga',
  kind: 'INTERNAL',
  startMs: 100,
  endMs: 160,
  status: 'UNSET',
  attributes: { 'gen_ai.operation.name': 'invoke_agent' },
  events: [],
  runId: 'run-1',
  ...overrides,
});

describe('runTraceOf', () => {
  it('summarises the spans recorded for the run and lists them without their events', async (context) => {
    const store = openTraceStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, path: path.join(withTempDir(context), 'traces.db'), clock: createFakeClock(0) });
    registerCleanup(context, () => store.close());
    store.writeSpans([
      span({}),
      span({ spanId: 's2', parentSpanId: 's1', name: 'execute_tool Read', startMs: 110, endMs: 120, attributes: { 'gen_ai.operation.name': 'execute_tool', 'momonga.step': 1 } }),
      span({ spanId: 's3', runId: 'other-run' }),
    ]);

    const trace = await runTraceOf({ local: store, gateway: NO_GATEWAY_SPANS }, 'run-1', OPEN);

    expect(trace?.runId).toBe('run-1');
    expect(trace?.summary).toMatchObject({ steps: 1, toolCalls: 1, chatCalls: 0, durationMs: 60 });
    expect(trace?.spans.map((entry) => entry.name)).toEqual(['invoke_agent momonga', 'execute_tool Read']);
    expect(trace?.spans[1]).toEqual({
      traceId: 't1',
      spanId: 's2',
      parentSpanId: 's1',
      name: 'execute_tool Read',
      kind: 'INTERNAL',
      startMs: 110,
      endMs: 120,
      status: 'UNSET',
      attributes: { 'gen_ai.operation.name': 'execute_tool', 'momonga.step': 1 },
    });
  });

  it('has no trace for a run without spans', async (context) => {
    const store = openTraceStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, path: path.join(withTempDir(context), 'traces.db'), clock: createFakeClock(0) });
    registerCleanup(context, () => store.close());

    expect(await runTraceOf({ local: store, gateway: NO_GATEWAY_SPANS }, 'run-1', OPEN)).toBeUndefined();
  });
});
