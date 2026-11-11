import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { createTelemetry } from '@momonga/observability';
import { createFakeClock, createScriptedAdapter, textResponseEvents, usageOf } from '@momonga/testkit';
import { PRIMARY, START_MS, postJson, readJson, readSse, registerCleanup, startGateway, userInput } from '../gateway-helpers.ts';

const UPSTREAM_TEXT = 'upstream body naming /home/person/secret-project';

const spansOf = async (captureMessageContent: boolean, fail: 'before output' | 'after output'): Promise<ReadableSpan[]> => {
  const memory = new InMemorySpanExporter();
  const telemetry = createTelemetry({
    serviceName: 'momonga-gateway-test',
    serviceVersion: '0.0.0',
    clock: createFakeClock(START_MS),
    exporters: [memory],
    captureMessageContent,
    batch: { maxQueueSize: 2048, scheduledDelayMs: 60_000, maxExportBatchSize: 512 },
  });
  registerCleanup(() => telemetry.shutdown());
  const events = fail === 'before output' ? [] : textResponseEvents({ model: 'scripted-primary', chunks: ['partial'], usage: usageOf(3, 1) }).slice(0, -1);
  const primary = createScriptedAdapter({ calls: [{ events, failure: { status: 400, message: UPSTREAM_TEXT } }] });
  const { client } = await startGateway({ adapters: { [PRIMARY]: primary }, telemetry, config: { retry: { maxAttempts: 1 } } });
  const response = await postJson(client, '/v1/responses', { model: PRIMARY, input: userInput('hi'), stream: true });
  if (fail === 'before output') await readJson(response);
  else await readSse(response);
  await telemetry.forceFlush();
  return memory.getFinishedSpans().filter((span) => span.attributes['gen_ai.operation.name'] === 'chat');
};

const recordedText = (spans: readonly ReadableSpan[]): string => JSON.stringify(spans.map((span) => ({ attributes: span.attributes, events: span.events.map((event) => event.attributes) })));

describe('free failure text leaves the machine only when content capture is on (gateway-core-C13)', () => {
  it.for([['before output'], ['after output']] as const)('keeps the upstream text of a failure %s off the span, recording its type, code and status', async ([when]) => {
    const spans = await spansOf(false, when);

    expect(spans).toHaveLength(1);
    expect(recordedText(spans)).not.toContain('secret-project');
    const [span] = spans;
    expect(span?.attributes['error.type']).toBe('invalid_request');
    expect(span?.attributes['momonga.error_code']).toBe('upstream_rejected');
    expect(span?.status.code).toBe(2);
  });

  it('records the upstream text when content capture is on', async () => {
    const spans = await spansOf(true, 'before output');

    expect(recordedText(spans)).toContain('secret-project');
  });
});
