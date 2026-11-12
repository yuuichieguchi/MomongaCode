import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { pageRunSpans, recordChatResponse, spanRecordOfView, startAgentSpan, startChatSpan, summarizeSpans } from '@momonga/observability';
import { RUN_ID, harness } from './helpers.ts';

const chatSpans = async (count: number) => {
  const h = harness();
  const agent = startAgentSpan(h.telemetry.tracer, { agentName: 'momonga', agentId: 'a1', conversationId: 'c1', runId: RUN_ID });
  const parent = trace.setSpan(ROOT_CONTEXT, agent);
  for (let step = 1; step <= count; step += 1) {
    h.clock.advance(10);
    const span = startChatSpan(h.telemetry.tracer, { providerName: 'openai', billing: 'metered', requestModel: 'gpt-x', stream: true, runId: RUN_ID, step, attempt: 1 }, parent);
    recordChatResponse(span, { finishReasons: ['stop'], usageSource: 'reported', usage: { inputTokens: 100, outputTokens: 10 } });
    span.end(h.clock.now());
  }
  const other = startChatSpan(h.telemetry.tracer, { providerName: 'openai', billing: 'metered', requestModel: 'gpt-x', stream: true, runId: 'run-other', step: 1, attempt: 1 });
  other.end(h.clock.now());
  await h.telemetry.forceFlush();
  return h;
};

describe('the spans of a run are read in bounded pages', () => {
  it('pages the spans of one run with a cursor, and no span of another run', async () => {
    const h = await chatSpans(3);

    const first = pageRunSpans(h.store, RUN_ID, 0, 2);
    expect(first.spans).toHaveLength(2);
    expect(first.next).not.toBeNull();
    const second = pageRunSpans(h.store, RUN_ID, first.next ?? 0, 2);
    expect(second.spans).toHaveLength(1);
    expect(second.next).toBeNull();
    expect([...first.spans, ...second.spans].map((span) => span.spanId).sort()).toEqual(h.store.spansForRun(RUN_ID).map((span) => span.spanId).sort());
  });

  it('refuses a page size out of its bounds', async () => {
    const h = await chatSpans(1);
    expect(() => pageRunSpans(h.store, RUN_ID, 0, 0)).toThrow(RangeError);
  });

  it('summarizes spans read back from their wire form the same as the stored spans', async () => {
    const h = await chatSpans(2);
    const page = pageRunSpans(h.store, RUN_ID, 0, 50);

    const summary = summarizeSpans(page.spans.map((view) => spanRecordOfView(view, RUN_ID)));

    expect(summary).toMatchObject({ chatCalls: 2, inputTokens: 200, outputTokens: 20 });
  });

  it('refuses a wire span whose attribute is not a span attribute value', () => {
    expect(() =>
      spanRecordOfView({ traceId: 't', spanId: 's', parentSpanId: null, name: 'chat', kind: 'CLIENT', startMs: 1, endMs: 2, status: 'OK', attributes: { nested: { deep: 1 } } }, RUN_ID),
    ).toThrow(TypeError);
  });
});
