import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createTelemetry } from '@momonga/observability';
import { ROLE_HEADER, RUN_ID_HEADER } from '@momonga/protocol';
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
    ['analysis', 'analysis'],
    ['classifier', 'classifier'],
  ])('guards a call billed to the wrong role: the %s value of the momonga-role header is recorded as role %s', async (header, role) => {
    const { client, chats } = await tracedGateway(1);
    const response = await readJson(
      await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), metadata: { run_id: 'run-1', step: '1' } }, header === undefined ? {} : { [ROLE_HEADER]: header }),
    );
    expect(response.status).toBe(200);
    const spans = await chats();
    expect(spans.map((span) => span.attributes['momonga.role'])).toEqual([role]);
  });

  it.each(['guideline', 'reflection', 'permission_classifier', 'anything the client likes'])(
    'guards a client map the gateway interprets: metadata.purpose %s is accepted and leaves the role at run',
    async (purpose) => {
      const { client, chats } = await tracedGateway(1);
      const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), metadata: { run_id: 'run-1', step: '1', purpose } }));
      expect(response.status).toBe(200);
      expect((await chats()).map((span) => span.attributes['momonga.role'])).toEqual(['run']);
    },
  );

  it.each(['compaction', 'run', 'Reflection', 'planner', ''])('guards a role nobody defined: the %j value of the momonga-role header is refused as a 400 invalid_request', async (header) => {
    const { client, chats } = await tracedGateway(1);
    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi') }, { [ROLE_HEADER]: header }));
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ type: 'invalid_request', code: 'invalid_role' });
    expect(await chats()).toEqual([]);
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
    expect(spans[0]?.attributes['gen_ai.response.id']).toBe(response.body.id);
  });

  it('records the response id the caller received on the chat span, the key the cost breakdown joins on', async () => {
    const { client, chats } = await tracedGateway(1);
    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
    expect(response.status).toBe(200);
    expect((await chats()).map((span) => span.attributes['gen_ai.response.id'])).toEqual([response.body.id]);
  });

  it('guards a compaction charged to no run: the run id header puts the compaction span on its run', async () => {
    const { client, chats } = await tracedGateway(0);
    const response = await readJson(await postJson(client, '/v1/responses/compact', { model: 'fast', input: userInput('read a.txt') }, { [RUN_ID_HEADER]: 'run-7', 'idempotency-key': 'key-1' }));
    expect(response.status).toBe(200);
    expect((await chats()).map((span) => span.attributes['momonga.run_id'])).toEqual(['run-7']);
  });
});
