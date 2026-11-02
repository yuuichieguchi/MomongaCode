import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import type { ProviderAdapter } from '@momonga/protocol';
import { createTelemetry } from '@momonga/observability';
import { createFakeClock, createScriptedAdapter, waitFor } from '@momonga/testkit';
import { decodeSse } from '@momonga/foundation';
import { START_MS, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import { bigTextEvents } from './gateway-support.ts';

const trackReturn = (inner: ProviderAdapter, onReturn: () => void): ProviderAdapter => ({
  ...inner,
  create: (request, ctx) => {
    const source = inner.create(request, ctx);
    return {
      [Symbol.asyncIterator]: () => {
        const iterator = source[Symbol.asyncIterator]();
        return {
          next: () => iterator.next(),
          return: async (value) => {
            onReturn();
            return iterator.return === undefined ? { done: true, value } : iterator.return(value);
          },
        };
      },
    };
  },
});

describe('a client that disconnects while a response streams', () => {
  it('ends the attempt span and returns the adapter iterator', async () => {
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
    let returned = false;
    const scripted = createScriptedAdapter({ calls: [{ events: bigTextEvents(200, 100_000) }] });
    const primary = trackReturn(scripted, () => {
      returned = true;
    });
    const { client, gateway } = await startGateway({
      adapters: { primary },
      clock,
      telemetry,
      config: { breaker: { failureThreshold: 1, openMs: 30_000 } },
    });
    const controller = new AbortController();
    const response = await client.request({
      method: 'POST',
      path: '/v1/responses',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fast', input: userInput('hi'), stream: true }),
      signal: controller.signal,
    });
    const frames = decodeSse(response.body);
    await frames.next();
    await waitFor(() => (scripted.calls[0]?.emitted ?? 0) >= 3, { description: 'relay suspended at a yield' });
    controller.abort();
    await waitFor(() => returned, { description: 'adapter iterator returned' });
    await telemetry.forceFlush();
    const chats = memory.getFinishedSpans().filter((span) => span.attributes['gen_ai.operation.name'] === 'chat');
    expect(chats).toHaveLength(1);
    expect(chats[0]?.attributes['error.type']).toBe('cancelled');
    expect(gateway.abandonedRuns).toBe(0);
  });
});
