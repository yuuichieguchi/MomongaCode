import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createTelemetry } from '@momonga/observability';
import { createFakeClock, createScriptedAdapter, textResponseEvents, usageOf } from '@momonga/testkit';
import { START_MS, postJson, readJson, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';

const aliasConfig = {
  aliases: { fast: ['primary', 'secondary'] },
  targets: { primary: { model: 'scripted-primary' }, secondary: { model: 'scripted-secondary' } },
  retry: { maxAttempts: 1, totalWaitMs: 1 },
};

describe('a call answered by a target other than the first of its alias', () => {
  it('names the target that failed and why in the response extension', async () => {
    const primary = createScriptedAdapter({ calls: [{ failure: { status: 503, message: 'primary is down' } }] });
    const secondary = createScriptedAdapter({
      calls: [{ events: textResponseEvents({ model: 'scripted-secondary', chunks: ['from secondary'], usage: usageOf(9, 3) }) }],
    });
    const { client } = await startGateway({ adapters: { primary, secondary }, config: aliasConfig });

    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi') }));

    expect(response.body.momonga.fallbackFrom).toEqual(['primary']);
    expect(response.body.momonga.fallbackCauses).toEqual([{ target: 'primary', code: 'upstream_error', message: 'primary is down' }]);
  });

  it('records the target on every chat span and the causes on the span of the answering call', async () => {
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
    const primary = createScriptedAdapter({ calls: [{ failure: { status: 503, message: 'primary is down' } }] });
    const secondary = createScriptedAdapter({
      calls: [{ events: textResponseEvents({ model: 'scripted-secondary', chunks: ['from secondary'], usage: usageOf(9, 3) }) }],
    });
    const { client } = await startGateway({ adapters: { primary, secondary }, clock, telemetry, config: aliasConfig });

    await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), metadata: { run_id: 'run-1', step: '1' } }));
    await telemetry.forceFlush();

    const chats = memory.getFinishedSpans().filter((span) => span.attributes['gen_ai.operation.name'] === 'chat');
    const failed = chats.find((span) => span.attributes['momonga.target'] === 'primary');
    const answered = chats.find((span) => span.attributes['momonga.target'] === 'secondary');
    expect(failed?.attributes['error.type']).toBe('server_error');
    expect(failed?.attributes['momonga.failure_message']).toBe('primary is down');
    expect(answered?.attributes['momonga.fallback_causes']).toBe(
      JSON.stringify([{ target: 'primary', code: 'upstream_error', message: 'primary is down' }]),
    );
    expect(failed?.attributes['momonga.fallback_causes']).toBeUndefined();
  });
});
