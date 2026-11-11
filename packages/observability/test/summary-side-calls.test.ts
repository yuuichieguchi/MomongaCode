import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { recordChatResponse, startAgentSpan, startChatSpan, summarizeRun } from '@momonga/observability';
import { RUN_ID, harness } from './helpers.ts';

describe('summarizeRun reads every chat span its writer may write', () => {
  it('summarises a run that holds a chat span with no step, and counts it as a side call', async () => {
    const h = harness();
    const tracer = h.telemetry.tracer;
    const agent = startAgentSpan(tracer, { agentName: 'momonga', agentId: 'a1', conversationId: 'c1', runId: RUN_ID });
    const parent = trace.setSpan(ROOT_CONTEXT, agent);
    const chat = (step: number | undefined, usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number }): void => {
      h.clock.advance(10);
      const span = startChatSpan(tracer, { providerName: 'openai', billing: 'metered', requestModel: 'gpt-x', stream: true, runId: RUN_ID, ...(step === undefined ? {} : { step }), attempt: 1 }, parent);
      h.clock.advance(100);
      recordChatResponse(span, { finishReasons: ['stop'], usageSource: 'reported', usage });
      span.end(h.clock.now());
    };
    chat(1, { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 });
    chat(undefined, { inputTokens: 40, outputTokens: 4, cachedInputTokens: 0 });
    agent.end(h.clock.now());
    await h.telemetry.forceFlush();

    const summary = summarizeRun(h.store, RUN_ID);

    expect(summary).toMatchObject({ steps: 1, chatCalls: 2, sideCalls: 1, inputTokens: 140, outputTokens: 14 });
    expect(summary.chatResults).toEqual([{ step: 1, attempt: 1, finishReasons: ['stop'] }]);
  });

  it('counts no side call in a run whose chat spans all carry a step', async () => {
    const h = harness();
    const span = startChatSpan(h.telemetry.tracer, { providerName: 'openai', billing: 'metered', requestModel: 'gpt-x', stream: true, runId: RUN_ID, step: 1, attempt: 1 });
    span.end(h.clock.now());
    await h.telemetry.forceFlush();
    expect(summarizeRun(h.store, RUN_ID).sideCalls).toBe(0);
  });
});
