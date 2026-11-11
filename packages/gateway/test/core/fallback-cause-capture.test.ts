import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createTelemetry } from '@momonga/observability';
import { createFakeClock, createScriptedAdapter, textResponseEvents, usageOf } from '@momonga/testkit';
import { START_MS, postJson, readJson, registerCleanup, startGateway, userInput } from '../gateway-helpers.ts';

const UPSTREAM_TEXT = 'primary down at /home/person/secret-project';

const causesOnSpan = async (captureMessageContent: boolean): Promise<unknown> => {
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
  const primary = createScriptedAdapter({ calls: [{ failure: { status: 503, message: UPSTREAM_TEXT } }] });
  const secondary = createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'scripted-secondary', chunks: ['ok'], usage: usageOf(3, 1) }) }] });
  const { client } = await startGateway({
    adapters: { 'scripted/scripted-primary': primary, 'scripted/scripted-secondary': secondary },
    telemetry,
    config: { chains: { 'scripted/scripted-primary': ['scripted/scripted-primary', 'scripted/scripted-secondary'] }, targets: { 'scripted/scripted-primary': {}, 'scripted/scripted-secondary': {} }, retry: { maxAttempts: 1, totalWaitMs: 1 } },
  });
  const response = await readJson(await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi') }));
  expect(response.status).toBe(200);
  await telemetry.forceFlush();
  const answered = memory.getFinishedSpans().find((span) => span.attributes['momonga.target'] === 'scripted/scripted-secondary');
  return JSON.parse(String(answered?.attributes['momonga.fallback_causes']));
};

describe('the fallback causes on a span carry no upstream message without content capture (gateway-core-C13)', () => {
  it('records the target and code of the failed member and no message without capture', async () => {
    expect(await causesOnSpan(false)).toEqual([{ target: 'scripted/scripted-primary', name: 'scripted-primary', code: 'upstream_error' }]);
  });

  it('records the message with capture', async () => {
    expect(await causesOnSpan(true)).toEqual([{ target: 'scripted/scripted-primary', name: 'scripted-primary', code: 'upstream_error', message: UPSTREAM_TEXT }]);
  });
});
