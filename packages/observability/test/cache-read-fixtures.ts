import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { MOMONGA_ATTRIBUTES, definePriceTable, recordChatResponse, startAgentSpan, startChatSpan } from '@momonga/observability';
import type { BilledCall, BreakdownCall } from '@momonga/observability';
import type { harness } from './helpers.ts';
import type { BilledCallAtCallTime } from './helpers.ts';

export const AT = Date.parse('2026-06-01T00:00:00Z');

export const TABLE = definePriceTable([
  { provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 2, cachedInputPerMTok: 0.5, cacheWritePerMTok: 2.5, outputPerMTok: 8, currency: 'USD' },
  { provider: 'home', model: 'free', effectiveFrom: '2026-01-01', inputPerMTok: 0, cachedInputPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0, currency: 'USD' },
]);

export type Billing = 'metered' | 'local' | 'plan' | 'unknown';

export type CallSpec = { billing?: Billing; input: number; cached?: number; cacheWrite?: number; output?: number };

export type Harness = ReturnType<typeof harness>;

const providerOf = (billing: Billing): { providerName: string; requestModel: string } =>
  billing === 'local' ? { providerName: 'home', requestModel: 'free' } : { providerName: 'acme', requestModel: 'm1' };

export const recordCalls = async (h: Harness, runId: string, specs: readonly CallSpec[]): Promise<void> => {
  const agent = startAgentSpan(h.telemetry.tracer, { agentName: 'momonga', agentId: 'momonga', conversationId: 's', runId });
  const parent = trace.setSpan(ROOT_CONTEXT, agent);
  for (const [index, spec] of specs.entries()) {
    h.clock.set(AT + index);
    const billing = spec.billing ?? 'metered';
    const chat = startChatSpan(
      h.telemetry.tracer,
      { ...providerOf(billing), billing: billing === 'unknown' ? 'metered' : billing, stream: true, runId, attempt: 1, step: index + 1, target: 'a' },
      parent,
    );
    if (billing === 'unknown') chat.setAttribute(MOMONGA_ATTRIBUTES.billing, 'unknown');
    recordChatResponse(chat, {
      finishReasons: ['stop'],
      usageSource: 'reported',
      usage: {
        inputTokens: spec.input,
        outputTokens: spec.output ?? 2,
        ...(spec.cached === undefined ? {} : { cachedInputTokens: spec.cached }),
        ...(spec.cacheWrite === undefined ? {} : { cacheWriteInputTokens: spec.cacheWrite }),
        reasoningTokens: 0,
      },
    });
    chat.end(h.clock.now());
  }
  agent.end(h.clock.now());
  await h.telemetry.forceFlush();
};

export const asBreakdownCall = (call: BilledCallAtCallTime): BreakdownCall => ({
  runId: call.runId,
  ...(call.step === undefined ? {} : { step: call.step }),
  ...(call.target === undefined ? {} : { target: call.target }),
  provider: call.provider,
  model: call.model,
  billing: call.billing,
  at: new Date(call.startMs),
  price: call.price,
  prefix: { broken: false },
  usage: call.usage,
});
