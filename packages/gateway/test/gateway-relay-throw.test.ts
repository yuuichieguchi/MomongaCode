import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createTelemetry } from '@momonga/observability';
import { createFakeClock, createScriptedAdapter, textResponseEvents } from '@momonga/testkit';
import { START_MS, getJson, postJson, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';

describe('a relay that throws before the response concludes', () => {
  it('records the failure on the span and the breaker instead of a client cancellation', async () => {
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
    const primary = createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'model-a', chunks: ['hi'] }) }] });
    const priceTable = new Proxy([], {
      get: (target, property, receiver) =>
        property === 'filter'
          ? () => {
              throw new Error('the price table is unavailable');
            }
          : Reflect.get(target, property, receiver),
    });
    const { client } = await startGateway({
      adapters: { primary },
      clock,
      telemetry,
      priceTable,
      config: { retry: { maxAttempts: 1, totalWaitMs: 1 }, breaker: { failureThreshold: 1, openMs: 30_000 } },
    });
    const response = await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi') });
    await response.text();
    await telemetry.forceFlush();
    const chats = memory.getFinishedSpans().filter((span) => span.attributes['gen_ai.operation.name'] === 'chat');
    expect(chats).toHaveLength(1);
    expect(chats[0]?.attributes['error.type']).not.toBe('cancelled');
    expect((await getJson(client, '/v1/momonga/health')).body.targets.primary.breaker).toBe('open');
  });
});
