import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createTelemetry, definePriceTable, priceCall } from '@momonga/observability';
import { createFakeClock, createScriptedAdapter, textResponseEvents, usageOf, waitFor } from '@momonga/testkit';
import { START_MS, postJson, readJson, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';

const DAY_MS = 86_400_000;

const BEFORE = { provider: 'scripted', model: 'scripted-primary', effectiveFrom: '2027-01-01', inputPerMTok: 1_000_000, outputPerMTok: 1_000_000, currency: 'USD' as const };
const AFTER = { ...BEFORE, effectiveFrom: '2027-01-16', inputPerMTok: 2_000_000, outputPerMTok: 2_000_000 };

const startMsOf = (span: { startTime: [number, number] }): number => span.startTime[0] * 1000 + Math.floor(span.startTime[1] / 1_000_000);

describe('the price time of a call is the start of its attempt span', () => {
  it('prices a call that spans an effectiveFrom boundary the same in the response cost and in the cost report', async () => {
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
    const table = definePriceTable([BEFORE, AFTER]);
    const adapter = createScriptedAdapter({
      calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['ok'], usage: usageOf(9, 3) }), gate: { name: 'spanning', afterEvents: 1 } }],
    });
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': adapter }, clock, telemetry, priceTable: table });

    const pending = postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi'), metadata: { run_id: 'run-1', step: '1' } });
    await waitFor(() => adapter.calls.length === 1, { description: 'the call to start' });
    clock.advance(DAY_MS);
    adapter.release('spanning');
    const response = await readJson(await pending);
    expect(response.status).toBe(200);

    await telemetry.forceFlush();
    const [span] = memory.getFinishedSpans().filter((finished) => finished.attributes['gen_ai.operation.name'] === 'chat');
    if (span === undefined) throw new Error('the call recorded no chat span');
    expect(startMsOf(span)).toBe(START_MS);
    const reported = priceCall({
      usageSource: 'reported',
      provider: 'scripted',
      model: 'scripted-primary',
      billing: 'metered',
      usage: { inputTokens: 9, outputTokens: 3, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
      at: new Date(startMsOf(span)),
      table,
    });
    if (reported.kind !== 'priced') throw new Error('the report prices the call');

    expect(reported.priceVersion).toBe('2027-01-01');
    expect(response.body.momonga.cost.priceVersion).toBe(reported.priceVersion);
    expect(response.body.momonga.cost.amount).toBe(12);
  });
});
