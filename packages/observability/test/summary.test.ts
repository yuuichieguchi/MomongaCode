import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import {
  recordChatResponse,
  recordError,
  startAgentSpan,
  startChatSpan,
  startToolSpan,
  summarizeRun,
} from '@momonga/observability';
import { RUN_ID, harness } from './helpers.ts';

describe('summarizeRun', () => {
  it('aggregates a stored run', async () => {
    const h = harness();
    const tracer = h.telemetry.tracer;
    const agent = startAgentSpan(tracer, { agentName: 'momonga', agentId: 'a1', conversationId: 'c1', runId: RUN_ID });
    const parent = trace.setSpan(ROOT_CONTEXT, agent);
    const chat = (step: number, attempt: number, finishReasons: string[], usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }) => {
      h.clock.advance(10);
      const span = startChatSpan(tracer, { providerName: 'openai', billing: 'metered', requestModel: 'gpt-x', stream: true, runId: RUN_ID, step, attempt }, parent);
      h.clock.advance(100);
      recordChatResponse(span, { finishReasons, usageSource: 'reported', usage });
      span.end(h.clock.now());
      return span;
    };
    const failed = (() => {
      h.clock.advance(10);
      const span = startChatSpan(tracer, { providerName: 'openai', billing: 'metered', requestModel: 'gpt-x', stream: true, runId: RUN_ID, step: 1, attempt: 1 }, parent);
      recordError(span, new Error('503'), 'http_503');
      h.clock.advance(5);
      span.end(h.clock.now());
      return span;
    })();
    chat(1, 2, ['tool_calls'], { inputTokens: 100, outputTokens: 10, cachedInputTokens: 60 });
    h.clock.advance(1);
    const tool = startToolSpan(tracer, { toolName: 'shell', toolCallId: 'call_1', toolType: 'function', runId: RUN_ID, step: 1 }, parent);
    h.clock.advance(20);
    tool.end(h.clock.now());
    chat(2, 1, ['stop'], { inputTokens: 200, outputTokens: 30 });
    h.clock.advance(4);
    agent.end(h.clock.now());
    startAgentSpan(tracer, { agentName: 'x', agentId: 'y', conversationId: 'z', runId: 'other-run' }).end(h.clock.now());
    await h.telemetry.forceFlush();
    expect(failed.spanContext().traceId).toBe(agent.spanContext().traceId);

    expect(summarizeRun(h.store, RUN_ID)).toEqual({
      steps: 2,
      chatCalls: 3,
      toolCalls: 1,
      inputTokens: 300,
      outputTokens: 40,
      cachedInputTokens: 60,
      cacheReadNotReportedCalls: 1,
      errorCount: 1,
      durationMs: 260,
      chatResults: [
        { step: 1, attempt: 1, finishReasons: [] },
        { step: 1, attempt: 2, finishReasons: ['tool_calls'] },
        { step: 2, attempt: 1, finishReasons: ['stop'] },
      ],
    });
  });

  it('returns zeros for an unknown run', () => {
    const h = harness();
    expect(summarizeRun(h.store, 'missing')).toEqual({
      steps: 0,
      chatCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheReadNotReportedCalls: 0,
      errorCount: 0,
      durationMs: 0,
      chatResults: [],
    });
  });

  it('reports one chat result per call so a retried step is not collapsed', async () => {
    const h = harness();
    const tracer = h.telemetry.tracer;
    for (const attempt of [1, 2]) {
      const span = startChatSpan(tracer, { providerName: 'openai', billing: 'metered', requestModel: 'gpt-x', stream: false, runId: RUN_ID, step: 1, attempt });
      recordChatResponse(span, { finishReasons: ['stop'], usageSource: 'reported', usage: { inputTokens: 1, outputTokens: 1 } });
      h.clock.advance(1);
      span.end(h.clock.now());
      h.clock.advance(1);
    }
    await h.telemetry.forceFlush();
    const summary = summarizeRun(h.store, RUN_ID);
    expect(summary.steps).toBe(1);
    expect(summary.chatCalls).toBe(2);
    expect(summary.chatResults).toEqual([
      { step: 1, attempt: 1, finishReasons: ['stop'] },
      { step: 1, attempt: 2, finishReasons: ['stop'] },
    ]);
  });
});
