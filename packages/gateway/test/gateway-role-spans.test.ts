import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createTelemetry } from '@momonga/observability';
import { createFakeClock, createScriptedAdapter, textResponseEvents, usageOf } from '@momonga/testkit';
import { START_MS, postJson, readJson, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';

const SUMMARY = 'User asked about a.txt; assistant read it and found three TODOs.';

const tracedGateway = async (calls: number) => {
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
  const primary = createScriptedAdapter({
    compactSummary: SUMMARY,
    calls: Array.from({ length: calls }, () => ({ events: textResponseEvents({ model: 'scripted-primary', chunks: ['ok'], usage: usageOf(9, 3) }) })),
  });
  const { client } = await startGateway({ adapters: { primary }, clock, telemetry });
  const chats = async () => {
    await telemetry.forceFlush();
    return memory.getFinishedSpans().filter((span) => span.attributes['gen_ai.operation.name'] === 'chat');
  };
  return { client, chats };
};

describe('the role of a model call on its chat span', () => {
  it.each([
    [undefined, 'run'],
    ['reflection', 'reflection'],
    ['guideline', 'analysis'],
    ['permission_classifier', 'classifier'],
  ])('guards a call billed to the wrong role: metadata purpose %s is recorded as role %s', async (purpose, role) => {
    const { client, chats } = await tracedGateway(1);
    const metadata = { run_id: 'run-1', step: '1', ...(purpose === undefined ? {} : { purpose }) };
    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), metadata }));
    expect(response.status).toBe(200);
    const spans = await chats();
    expect(spans.map((span) => span.attributes['momonga.role'])).toEqual([role]);
  });

  it('guards a compaction that never reaches the cost report: a compaction call is recorded as a chat span of role compaction with its usage', async () => {
    const { client, chats } = await tracedGateway(0);
    const response = await readJson(await postJson(client, '/v1/responses/compact', { model: 'fast', input: userInput('read a.txt') }));
    expect(response.status).toBe(200);
    const spans = await chats();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes['momonga.role']).toBe('compaction');
    expect(spans[0]?.attributes['momonga.target']).toBe('primary');
    expect(spans[0]?.attributes['gen_ai.usage.input_tokens']).toBe(response.body.usage.input_tokens);
    expect(spans[0]?.attributes['gen_ai.usage.output_tokens']).toBe(response.body.usage.output_tokens);
  });
});
