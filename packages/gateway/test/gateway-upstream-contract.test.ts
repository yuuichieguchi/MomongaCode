import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createTelemetry } from '@momonga/observability';
import { createReplayAdapter } from '@momonga/gateway';
import type { StreamEvent } from '@momonga/protocol';
import { createFakeClock, createScriptedAdapter, responseResource, textResponseEvents } from '@momonga/testkit';
import {
  START_MS,
  expectErrorBody,
  getJson,
  makeDir,
  outputText,
  postJson,
  readJson,
  readSse,
  registerCleanup,
  startGateway,
  userInput,
  validator,
} from './gateway-helpers.ts';

const request = { model: 'fast', input: userInput('hi') };
const streamRequest = { ...request, stream: true };

const malformedFailed = (): StreamEvent[] => {
  const events = textResponseEvents({ model: 'scripted-primary', chunks: ['part'] });
  return [
    ...events.slice(0, 5),
    {
      type: 'response.failed',
      sequence_number: 9,
      response: { ...responseResource({ id: 'up', model: 'm', status: 'failed' }), error: null as never },
    },
  ];
};

describe('malformed upstream events', () => {
  it('turns response.failed without an error into response.failed upstream_protocol_error and counts against the breaker', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: malformedFailed() }] });
    const { client } = await startGateway({ adapters: { primary }, config: { breaker: { failureThreshold: 1 } } });
    const frames = await readSse(await postJson(client, '/v1/responses', streamRequest));
    const last = frames.at(-1)?.data;
    expect(last.type).toBe('response.failed');
    expect(last.response.error.code).toBe('upstream_protocol_error');
    expect(validator.validate('ResponseFailedStreamingEvent', last).errors).toEqual([]);
    expect(frames.filter((frame) => frame.data.type === 'response.failed')).toHaveLength(1);
    expect((await getJson(client, '/v1/momonga/health')).body.targets.primary.breaker).toBe('open');
  });

  it('maps the same failure for a non-stream request to a model_error 502 with the code', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: malformedFailed() }] });
    const { client } = await startGateway({ adapters: { primary } });
    const response = await readJson(await postJson(client, '/v1/responses', request));
    expect(response.status).toBe(502);
    expectErrorBody(response.body, { type: 'model_error', code: 'upstream_protocol_error' });
  });
});

describe('terminal event handling', () => {
  it('completes the response without waiting for the adapter to finish after its terminal event', async () => {
    const primary = createScriptedAdapter({
      calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['done'] }), gate: { name: 'tail', afterEvents: 99 } }],
    });
    const { client } = await startGateway({ adapters: { primary } });
    const response = await readJson(await postJson(client, '/v1/responses', request));
    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('done');
    primary.release('tail');
  });

  it('does not fail a completed response when the adapter errors after its terminal event', async () => {
    const primary = createScriptedAdapter({
      calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['done'] }), failure: { status: 503, message: 'late reset' } }],
    });
    const { client } = await startGateway({ adapters: { primary } });
    const frames = await readSse(await postJson(client, '/v1/responses', streamRequest));
    expect(frames.at(-1)?.data.type).toBe('response.completed');
  });

  it('writes the replay recording through the gateway when the stream is closed at the terminal event', async () => {
    const inner = createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['rec'] }) }] });
    const file = path.join(makeDir(), 'recording.jsonl');
    const primary = createReplayAdapter({ path: file, mode: 'record', inner });
    const { client } = await startGateway({ adapters: { primary } });
    expect((await readJson(await postJson(client, '/v1/responses', request))).status).toBe(200);
    expect(fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')).toHaveLength(1);
  });

  it('records an adapter that throws while being closed as a span event and still completes', async () => {
    const clock = createFakeClock(START_MS);
    const memory = new InMemorySpanExporter();
    const telemetry = createTelemetry({
      serviceName: 'gw',
      serviceVersion: '0',
      clock,
      exporters: [memory],
      batch: { maxQueueSize: 2048, scheduledDelayMs: 60_000, maxExportBatchSize: 512 },
    });
    registerCleanup(() => telemetry.shutdown());
    const base = createScriptedAdapter({ calls: [] });
    const events = textResponseEvents({ model: 'scripted-primary', chunks: ['x'] });
    const primary = {
      ...base,
      create: async function* (): AsyncGenerator<StreamEvent> {
        try {
          yield* events;
        } finally {
          throw new Error('cleanup exploded');
        }
      },
    };
    const { client } = await startGateway({ adapters: { primary }, clock, telemetry });
    expect((await readJson(await postJson(client, '/v1/responses', request))).status).toBe(200);
    await telemetry.forceFlush();
    const span = memory.getFinishedSpans().find((candidate) => candidate.attributes['gen_ai.operation.name'] === 'chat');
    expect(span?.events.map((event) => event.name)).toContain('momonga.adapter_cleanup_error');
  });
});

describe('failed responses keep the original error type', () => {
  const interrupted = (status: number) =>
    createScriptedAdapter({
      calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['a', 'b'] }).slice(0, 5), failure: { status, message: 'dropped' } }],
    });

  it('maps a rate-limited interruption to 429 too_many_requests', async () => {
    const { client } = await startGateway({ adapters: { primary: interrupted(429) } });
    const response = await readJson(await postJson(client, '/v1/responses', request));
    expect(response.status).toBe(429);
    expectErrorBody(response.body, { type: 'too_many_requests', code: 'stream_interrupted' });
  });

  it('maps an unclassified interruption to 502 model_error', async () => {
    const base = createScriptedAdapter({ calls: [] });
    const primary = {
      ...base,
      create: async function* (): AsyncGenerator<StreamEvent> {
        yield* textResponseEvents({ model: 'scripted-primary', chunks: ['a'] }).slice(0, 4);
        throw new Error('parser blew up');
      },
    };
    const { client } = await startGateway({ adapters: { primary } });
    const response = await readJson(await postJson(client, '/v1/responses', request));
    expect(response.status).toBe(502);
    expectErrorBody(response.body, { type: 'model_error', code: 'stream_interrupted' });
  });

  it('keeps server_error for a 5xx interruption', async () => {
    const { client } = await startGateway({ adapters: { primary: interrupted(503) } });
    const response = await readJson(await postJson(client, '/v1/responses', request));
    expect(response.status).toBe(502);
    expectErrorBody(response.body, { type: 'server_error', code: 'stream_interrupted' });
  });
});
