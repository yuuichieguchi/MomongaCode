import { describe, expect, it } from 'vitest';
import type { SpanRecord } from '@momonga/observability';
import { runTraceOf } from '../../src/service/trace-view.ts';

const RUN = 'run-1';
const OPEN = new AbortController().signal;

const GATEWAY_CHAT: SpanRecord = {
  traceId: 't',
  spanId: 'gw-chat',
  parentSpanId: 'agent',
  name: 'chat gpt-x',
  kind: 'CLIENT',
  startMs: 5,
  endMs: 9,
  status: 'OK',
  attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.usage.input_tokens': 120, 'gen_ai.usage.output_tokens': 30, 'momonga.step': 1, 'momonga.attempt': 1, 'gen_ai.response.finish_reasons': ['stop'] },
  events: [],
  runId: RUN,
};

const LOCAL_AGENT = {
  traceId: 't',
  spanId: 'agent',
  parentSpanId: null,
  name: 'invoke_agent momonga',
  kind: 'INTERNAL' as const,
  startMs: 1,
  endMs: 12,
  status: 'UNSET' as const,
  attributes: { 'gen_ai.operation.name': 'invoke_agent' },
  events: [],
  runId: RUN,
};

describe('the trace of a run reads the spans of every store that holds part of it', () => {
  it('reports the chat call the gateway holds for the run, with its tokens, beside the spans of the runtime', async () => {
    const asked: string[] = [];
    const trace = await runTraceOf(
      {
        local: { spansForRun: () => [LOCAL_AGENT] },
        gateway: {
          runSpans: async (runId) => {
            asked.push(runId);
            return [GATEWAY_CHAT];
          },
        },
      },
      RUN,
      OPEN,
    );

    expect(asked).toEqual([RUN]);
    expect(trace?.summary).toMatchObject({ chatCalls: 1, inputTokens: 120, outputTokens: 30, durationMs: 11 });
    expect(trace?.spans.map((span) => span.spanId)).toEqual(['agent', 'gw-chat']);
  });

  it('fails when the gateway cannot answer, and shows no count', async () => {
    const failure = new Error('gateway unreachable');
    await expect(runTraceOf({ local: { spansForRun: () => [LOCAL_AGENT] }, gateway: { runSpans: async () => Promise.reject(failure) } }, RUN, OPEN)).rejects.toBe(failure);
  });

  it('has no trace when neither store holds a span of the run', async () => {
    expect(await runTraceOf({ local: { spansForRun: () => [] }, gateway: { runSpans: async () => [] } }, RUN, OPEN)).toBeUndefined();
  });
});
