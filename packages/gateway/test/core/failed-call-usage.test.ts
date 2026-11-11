import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createTelemetry, definePriceTable } from '@momonga/observability';
import { createFakeClock, createScriptedAdapter, textResponseEvents, usageOf } from '@momonga/testkit';
import type { StreamEvent } from '@momonga/protocol';
import { PRIMARY, START_MS, postJson, readSse, registerCleanup, startGateway, userInput } from '../gateway-helpers.ts';

const PRICES = definePriceTable([{ provider: 'scripted', model: 'scripted-primary', effectiveFrom: '1970-01-01', inputPerMTok: 1, outputPerMTok: 1, currency: 'USD' }]);

const recordingTelemetry = () => {
  const memory = new InMemorySpanExporter();
  const telemetry = createTelemetry({
    serviceName: 'momonga-gateway-test',
    serviceVersion: '0.0.0',
    clock: createFakeClock(START_MS),
    exporters: [memory],
    batch: { maxQueueSize: 2048, scheduledDelayMs: 60_000, maxExportBatchSize: 512 },
  });
  registerCleanup(() => telemetry.shutdown());
  return { memory, telemetry };
};

const chatSpans = async (recording: ReturnType<typeof recordingTelemetry>) => {
  await recording.telemetry.forceFlush();
  return recording.memory.getFinishedSpans().filter((span) => span.attributes['gen_ai.operation.name'] === 'chat');
};

const terminalOf = async (response: Awaited<ReturnType<typeof postJson>>): Promise<any> => {
  const frames = await readSse(response);
  return frames.at(-1)?.data;
};

const completedEvents = (): StreamEvent[] => textResponseEvents({ model: 'scripted-primary', chunks: ['partial answer text'], usage: usageOf(30, 9) });

describe('a billed attempt that fails returns its usage in the reply (gateway-core-C02)', () => {
  it('returns an estimated usage, unpriced as an estimate, when the stream breaks after output', async () => {
    const recording = recordingTelemetry();
    const events = completedEvents().slice(0, -1);
    const primary = createScriptedAdapter({ calls: [{ events, failure: { status: 400, message: 'connection reset' } }] });
    const { client } = await startGateway({ adapters: { [PRIMARY]: primary }, telemetry: recording.telemetry, priceTable: PRICES });

    const terminal = await terminalOf(await postJson(client, '/v1/responses', { model: PRIMARY, input: userInput('hi'), stream: true }));

    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.usage.output_tokens).toBeGreaterThan(0);
    expect(terminal.response.usage.input_tokens).toBeGreaterThan(0);
    expect(terminal.response.momonga.usageSource).toBe('estimated');
    expect(terminal.response.momonga.unpriced.code).toBe('usage_not_reported');
    const [span] = await chatSpans(recording);
    expect(span?.attributes['gen_ai.usage.output_tokens']).toBe(terminal.response.usage.output_tokens);
    expect(span?.attributes['momonga.usage_source']).toBe('estimated');
  });

  it('returns the reported usage of an upstream answer that failed', async () => {
    const events = completedEvents();
    const terminal = events.at(-1) as Extract<StreamEvent, { type: 'response.completed' }>;
    const failed: StreamEvent = {
      type: 'response.failed',
      sequence_number: terminal.sequence_number,
      response: { ...terminal.response, status: 'failed', error: { code: 'content_filter', message: 'refused', type: 'invalid_request' } as never },
    };
    const primary = createScriptedAdapter({ calls: [{ events: [...events.slice(0, -1), failed] }] });
    const { client } = await startGateway({ adapters: { [PRIMARY]: primary }, priceTable: PRICES });

    const reply = await terminalOf(await postJson(client, '/v1/responses', { model: PRIMARY, input: userInput('hi'), stream: true }));

    expect(reply.type).toBe('response.failed');
    expect([reply.response.usage.input_tokens, reply.response.usage.output_tokens]).toEqual([30, 9]);
    expect(reply.response.momonga.usageSource).toBe('reported');
    expect(reply.response.momonga.cost.units).toBe('39000000000');
  });

  it('returns the reported usage when the answer arrived but could not be stored', async () => {
    const recording = recordingTelemetry();
    const primary = createScriptedAdapter({ calls: [{ events: completedEvents() }] });
    const { client, dbPath } = await startGateway({ adapters: { [PRIMARY]: primary }, telemetry: recording.telemetry, priceTable: PRICES });
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TRIGGER refuse_idempotency BEFORE INSERT ON idempotency BEGIN SELECT RAISE(ABORT, 'refused by the test'); END;");
    db.close();

    const reply = await terminalOf(await postJson(client, '/v1/responses', { model: PRIMARY, input: userInput('hi'), stream: true }, { 'idempotency-key': 'key-c02-commit' }));

    expect(reply.type).toBe('response.failed');
    expect(reply.response.error.code).toBe('internal_error');
    expect([reply.response.usage.input_tokens, reply.response.usage.output_tokens]).toEqual([30, 9]);
    expect(reply.response.momonga.cost.units).toBe('39000000000');
    const [span] = await chatSpans(recording);
    expect(span?.attributes['gen_ai.usage.input_tokens']).toBe(30);
  });
});
