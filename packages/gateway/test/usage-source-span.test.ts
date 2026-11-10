import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createTelemetry, definePriceTable } from '@momonga/observability';
import { createFakeClock, createScriptedAdapter, textResponseEvents, usageOf } from '@momonga/testkit';
import { START_MS, postJson, readJson, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';

const ENTRY = { provider: 'scripted', model: 'scripted-primary', effectiveFrom: '1970-01-01', inputPerMTok: 1, cachedInputPerMTok: 1, outputPerMTok: 1, currency: 'USD' as const };

const chatSpanOf = async (usage: ReturnType<typeof usageOf> | null) => {
  const clock = createFakeClock(START_MS);
  const memory = new InMemorySpanExporter();
  const telemetry = createTelemetry({
    serviceName: 'momonga-gateway-test',
    serviceVersion: '0.0.0',
    clock,
    exporters: [memory],
    batch: { maxQueueSize: 2048, scheduledDelayMs: 60_000, maxExportBatchSize: 512 },
  });
  registerCleanup(() => telemetry.shutdown());
  const adapter = createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['ok'], usage }) }] });
  const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': adapter }, clock, telemetry, priceTable: definePriceTable([ENTRY]) });
  const response = await readJson(await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi'), metadata: { run_id: 'run-1', step: '1' } }));
  expect(response.status).toBe(200);
  await telemetry.forceFlush();
  const [span] = memory.getFinishedSpans().filter((finished) => finished.attributes['gen_ai.operation.name'] === 'chat');
  if (span === undefined) throw new Error('the call recorded no chat span');
  return { span, response };
};

describe('the chat span records the usage source of the call', () => {
  it('writes momonga.usage_source estimated when the upstream sent no usage', async () => {
    const { span, response } = await chatSpanOf(null);

    expect(response.body.momonga.usageSource).toBe('estimated');
    expect(span.attributes['momonga.usage_source']).toBe('estimated');
  });

  it('writes momonga.usage_source reported when the upstream sent its usage', async () => {
    const { span, response } = await chatSpanOf(usageOf(9, 3));

    expect(response.body.momonga.usageSource).toBe('reported');
    expect(span.attributes['momonga.usage_source']).toBe('reported');
  });
});
