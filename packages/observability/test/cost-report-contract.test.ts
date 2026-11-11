import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { RUN_API_SCHEMAS } from '@momonga/protocol';
import { definePriceTable, recordChatResponse, recordFallbackCauses, startAgentSpan, startChatSpan } from '@momonga/observability';
import { harness, costReportOfSpans } from './helpers.ts';

type SchemaNode = { properties: Record<string, SchemaNode>; items: SchemaNode };

const TABLE = definePriceTable([{ provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 2, outputPerMTok: 8, currency: 'USD' }]);
const AT_JULY = Date.parse('2026-07-10T00:00:00Z');

const costReport = (RUN_API_SCHEMAS as unknown as Record<string, SchemaNode>)['CostReport'] as SchemaNode;
const causeSchema = costReport.properties['runs']!.items.properties['fallbacks']!.items.properties['failed']!.items;
const causeAccepted = new Ajv2020.default({ strict: true, allErrors: true }).compile(causeSchema as unknown as Record<string, unknown>);

const ALLOWED_CAUSE = { target: 'plan', code: 'plan_usage_unavailable', message: 'Try again later.', fromBilling: 'plan', toBilling: 'metered', reason: 'billing_change_allowed' } as const;

describe('a cost report holding a billing change keeps the Run API contract', () => {
  it('reports the allowed billing change as written and the schema accepts it', async () => {
    const h = harness();
    const agent = startAgentSpan(h.telemetry.tracer, { agentName: 'momonga', agentId: 'momonga', conversationId: 's', runId: 'run-a' });
    const parent = trace.setSpan(ROOT_CONTEXT, agent);
    for (const [index, fallback] of [false, true].entries()) {
      h.clock.set(AT_JULY);
      const chat = startChatSpan(
        h.telemetry.tracer,
        { providerName: 'acme', billing: 'metered', requestModel: 'm1', stream: true, runId: 'run-a', step: index + 1, attempt: 1, target: fallback ? 'metered' : 'plan' },
        parent,
      );
      recordChatResponse(chat, { finishReasons: ['stop'], usageSource: 'reported', usage: { inputTokens: 10, outputTokens: 5 } });
      if (fallback) recordFallbackCauses(chat, [ALLOWED_CAUSE], true);
      chat.end(h.clock.now());
    }
    agent.end(h.clock.now());
    await h.telemetry.forceFlush();

    const report = costReportOfSpans(h.store, [{ runId: 'run-a', sessionId: 's' }], { table: TABLE });

    const failed = report.total.fallbacks?.[0]?.failed;
    expect(failed).toEqual([ALLOWED_CAUSE]);
    expect((failed ?? []).map((cause) => causeAccepted(cause))).toEqual([true]);
  });
});
