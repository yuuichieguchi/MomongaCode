import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { joinBreakdownCalls, recordChatResponse, startAgentSpan, startChatSpan } from '@momonga/observability';
import { harness } from './helpers.ts';

const AT = Date.parse('2026-06-01T00:00:00Z');

type Spec = { step?: number; purpose?: string; input: number; cached?: number; cacheWrite?: number };

const record = async (runId: string, specs: readonly Spec[], h: ReturnType<typeof harness>): Promise<void> => {
  const agent = startAgentSpan(h.telemetry.tracer, { agentName: 'momonga', agentId: 'momonga', conversationId: 's', runId });
  const parent = trace.setSpan(ROOT_CONTEXT, agent);
  for (const [index, spec] of specs.entries()) {
    h.clock.set(AT + index);
    const chat = startChatSpan(
      h.telemetry.tracer,
      {
        providerName: 'acme',
        billing: 'metered',
        requestModel: 'm1',
        stream: true,
        runId,
        attempt: 1,
        ...(spec.step === undefined ? {} : { step: spec.step }),
        ...(spec.purpose === undefined ? {} : { purpose: spec.purpose }),
      },
      parent,
    );
    recordChatResponse(chat, {
      finishReasons: ['stop'],
      usage: {
        inputTokens: spec.input,
        outputTokens: 2,
        ...(spec.cached === undefined ? {} : { cachedInputTokens: spec.cached }),
        ...(spec.cacheWrite === undefined ? {} : { cacheWriteInputTokens: spec.cacheWrite }),
        reasoningTokens: 1,
      },
    });
    chat.end(h.clock.now());
  }
  agent.end(h.clock.now());
  await h.telemetry.forceFlush();
};

describe('joinBreakdownCalls', () => {
  it('gives each recorded model response the provider, model, billing and tokens of the billed chat span of its step', async () => {
    const h = harness();
    await record('run-a', [{ step: 1, input: 100, cached: 10, cacheWrite: 20 }, { step: 2, input: 200 }], h);

    const joined = joinBreakdownCalls(h.store, ['run-a'], [
      { runId: 'run-a', step: 1, timing: { firstEventMs: 5, durationMs: 9 } },
      { runId: 'run-a', step: 2 },
    ]);

    expect(joined).toHaveLength(2);
    expect(joined[0]).toMatchObject({
      runId: 'run-a',
      step: 1,
      provider: 'acme',
      model: 'm1',
      billing: 'metered',
      usage: { inputTokens: 100, cachedInputTokens: 10, cacheWriteInputTokens: 20, outputTokens: 2, reasoningTokens: 1 },
      timing: { firstEventMs: 5, durationMs: 9 },
    });
    expect(joined[1]?.usage).toMatchObject({ inputTokens: 200, cachedInputTokens: 0, cacheWriteInputTokens: 0 });
  });

  it('adds a call made for a purpose, such as the permission classifier, as a billed call without layers or timing instead of failing the join', async () => {
    const h = harness();
    await record('run-a', [{ step: 1, input: 100 }, { step: 1, purpose: 'permission_classifier', input: 30 }, { purpose: 'reflection', input: 40 }], h);

    const joined = joinBreakdownCalls(h.store, ['run-a'], [{ runId: 'run-a', step: 1 }]);

    expect(joined.map((call) => call.usage.inputTokens).sort((left, right) => left - right)).toEqual([30, 40, 100]);
    expect(joined.filter((call) => call.timing === undefined && call.anatomy === undefined)).toHaveLength(3);
  });

  it('refuses a step whose recorded responses and billed chat spans differ in number', async () => {
    const h = harness();
    await record('run-a', [{ step: 1, input: 100 }], h);

    expect(() => joinBreakdownCalls(h.store, ['run-a'], [{ runId: 'run-a', step: 1 }, { runId: 'run-a', step: 1 }])).toThrow(/step 1 recorded 2 model response/);
    expect(() => joinBreakdownCalls(h.store, ['run-a'], [])).toThrow(/step 1 recorded 0 model response/);
  });
});
