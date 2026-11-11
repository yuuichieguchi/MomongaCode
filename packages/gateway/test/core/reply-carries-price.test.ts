import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createTelemetry, definePriceTable } from '@momonga/observability';
import { createFakeClock, createScriptedAdapter, textResponseEvents, usageOf, waitFor } from '@momonga/testkit';
import { PRIMARY, START_MS, postJson, readJson, registerCleanup, startGateway, userInput } from '../gateway-helpers.ts';

const DAY_MS = 86_400_000;
const IN_FORCE = { provider: 'scripted', model: 'scripted-primary', effectiveFrom: '2027-01-01', inputPerMTok: 1_000_000, outputPerMTok: 1_000_000, currency: 'USD' as const };
const LATER = { ...IN_FORCE, effectiveFrom: '2027-01-16', inputPerMTok: 2_000_000, outputPerMTok: 2_000_000 };

const recording = (clock: ReturnType<typeof createFakeClock>) => {
  const memory = new InMemorySpanExporter();
  const telemetry = createTelemetry({
    serviceName: 'momonga-gateway-test',
    serviceVersion: '0.0.0',
    clock,
    exporters: [memory],
    batch: { maxQueueSize: 2048, scheduledDelayMs: 60_000, maxExportBatchSize: 512 },
  });
  registerCleanup(() => telemetry.shutdown());
  return { memory, telemetry };
};

const costKeysOf = async (record: ReturnType<typeof recording>): Promise<string[]> => {
  await record.telemetry.forceFlush();
  return record.memory.getFinishedSpans().flatMap((span) => Object.keys(span.attributes).filter((key) => key.includes('cost') || key.includes('price')));
};

describe('the reply carries the price computed once at the call (gateway-core-C12)', () => {
  it('prices a response with the table in force when the call started and writes no price onto its span', async () => {
    const clock = createFakeClock(START_MS);
    const record = recording(clock);
    const adapter = createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['ok'], usage: usageOf(9, 3) }), gate: { name: 'held', afterEvents: 1 } }] });
    const { client } = await startGateway({ adapters: { [PRIMARY]: adapter }, clock, telemetry: record.telemetry, priceTable: definePriceTable([IN_FORCE, LATER]) });

    const pending = postJson(client, '/v1/responses', { model: PRIMARY, input: userInput('hi') });
    await waitFor(() => adapter.calls.length === 1, { description: 'the call to start' });
    clock.advance(DAY_MS);
    adapter.release('held');
    const response = await readJson(await pending);

    expect(response.body.momonga.cost).toEqual({ amount: 12, units: '12000000000000000', currency: 'USD', priceVersion: '2027-01-01' });
    expect(await costKeysOf(record)).toEqual([]);
  });

  it('prices a compaction with the table in force when its attempt started and writes no price onto its span', async () => {
    const clock = createFakeClock(START_MS);
    const record = recording(clock);
    const adapter = createScriptedAdapter({ calls: [], compactSummary: 'summary', compactGate: 'held' });
    const { client } = await startGateway({ adapters: { [PRIMARY]: adapter }, clock, telemetry: record.telemetry, priceTable: definePriceTable([IN_FORCE, LATER]) });

    const pending = postJson(client, '/v1/responses/compact', { model: PRIMARY, input: userInput('hi') });
    await waitFor(() => adapter.compactCalls.length === 1, { description: 'the compaction to start' });
    clock.advance(DAY_MS);
    adapter.release('held');
    const response = await readJson(await pending);

    expect(response.status).toBe(200);
    expect(response.body.momonga.cost.priceVersion).toBe('2027-01-01');
    expect(response.body.momonga.cost.amount).toBe(48);
    expect(await costKeysOf(record)).toEqual([]);
  });
});
