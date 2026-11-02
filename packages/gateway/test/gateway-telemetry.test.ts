import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createTelemetry } from '@momonga/observability';
import { createFakeClock, createScriptedAdapter, textResponseEvents, usageOf, waitFor } from '@momonga/testkit';
import { START_MS, postJson, readJson, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const PARENT_SPAN_ID = 'b7ad6b7169203331';

describe('gateway telemetry', () => {
  it('records one chat span per upstream attempt under the traceparent context, with usage and error.type', async () => {
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
      calls: [
        { failure: { status: 503, message: 'busy' } },
        { events: textResponseEvents({ model: 'scripted-primary', chunks: ['traced'], usage: usageOf(17, 5) }) },
      ],
    });
    const { client, timers } = await startGateway({ adapters: { primary }, clock, telemetry, config: { retry: { maxAttempts: 2 } } });
    const pending = postJson(
      client,
      '/v1/responses',
      { model: 'fast', input: userInput('hi'), metadata: { run_id: 'run-7', step: '4' } },
      { traceparent: `00-${TRACE_ID}-${PARENT_SPAN_ID}-01` },
    );
    await waitFor(() => primary.calls.length === 1 && timers.pending().length > 0);
    timers.advance(timers.pending().at(-1)?.delayMs ?? 0);
    expect((await readJson(await pending)).status).toBe(200);
    await telemetry.forceFlush();

    const chats = memory.getFinishedSpans().filter((span) => span.attributes['gen_ai.operation.name'] === 'chat');
    expect(chats).toHaveLength(2);
    for (const span of chats) {
      expect(span.spanContext().traceId).toBe(TRACE_ID);
      expect(span.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);
      expect(span.attributes['gen_ai.request.model']).toBe('scripted-primary');
      expect(span.attributes['momonga.run_id']).toBe('run-7');
      expect(span.attributes['momonga.step']).toBe(4);
    }
    const [failed, succeeded] = [...chats].sort((left, right) => Number(left.attributes['momonga.attempt']) - Number(right.attributes['momonga.attempt']));
    expect(failed?.attributes['momonga.attempt']).toBe(1);
    expect(failed?.attributes['error.type']).toBe('server_error');
    expect(succeeded?.attributes['momonga.attempt']).toBe(2);
    expect(succeeded?.attributes['error.type']).toBeUndefined();
    expect(succeeded?.attributes['gen_ai.usage.input_tokens']).toBe(17);
    expect(succeeded?.attributes['gen_ai.usage.output_tokens']).toBe(5);
  });

  it('names the configured provider of the target, not the adapter kind, on the chat span', async () => {
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
    const primary = createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['ok'], usage: usageOf(3, 1) }) }] });
    const { client } = await startGateway({
      adapters: { primary },
      clock,
      telemetry,
      config: { targets: { primary: { model: 'scripted-primary', provider: 'apple' } } },
    });
    expect((await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi') }))).status).toBe(200);
    await telemetry.forceFlush();
    const [chat] = memory.getFinishedSpans().filter((span) => span.attributes['gen_ai.operation.name'] === 'chat');
    expect(chat?.attributes['gen_ai.provider.name']).toBe('apple');
    expect(chat?.name).toBe('chat scripted-primary');
  });
});

describe('gateway telemetry message content', () => {
  const contentRun = async (captureMessageContent: boolean | undefined) => {
    const clock = createFakeClock(START_MS);
    const memory = new InMemorySpanExporter();
    const telemetry = createTelemetry({
      serviceName: 'momonga-gateway-test',
      serviceVersion: '0.0.0',
      clock,
      exporters: [memory],
      batch: { maxQueueSize: 2048, scheduledDelayMs: 60_000, maxExportBatchSize: 512 },
      ...(captureMessageContent === undefined ? {} : { captureMessageContent }),
    });
    registerCleanup(() => telemetry.shutdown());
    const primary = createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['the answer'], usage: usageOf(3, 1) }) }] });
    const { client } = await startGateway({ adapters: { primary }, clock, telemetry });
    const body = {
      model: 'fast',
      instructions: 'Be terse.',
      input: [
        { type: 'message', role: 'user', content: 'what is in a.txt?' },
        { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"file_path":"a.txt"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'file text' },
      ],
      tools: [{ type: 'function', name: 'Read', description: 'Read a file', parameters: { type: 'object' } }],
    };
    expect((await readJson(await postJson(client, '/v1/responses', body))).status).toBe(200);
    await telemetry.forceFlush();
    const [chat] = memory.getFinishedSpans().filter((span) => span.attributes['gen_ai.operation.name'] === 'chat');
    return chat?.attributes ?? {};
  };

  it('exports no message content unless the user opted in', async () => {
    const attributes = await contentRun(undefined);

    for (const key of ['gen_ai.system_instructions', 'gen_ai.input.messages', 'gen_ai.output.messages', 'gen_ai.tool.definitions']) {
      expect(attributes).not.toHaveProperty(key);
    }
  });

  it('exports the instructions, the input and output messages and the tool definitions as the pinned opt-in attributes when the user opted in', async () => {
    const attributes = await contentRun(true);

    expect(JSON.parse(String(attributes['gen_ai.system_instructions']))).toEqual([{ type: 'text', content: 'Be terse.' }]);
    expect(JSON.parse(String(attributes['gen_ai.input.messages']))).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'what is in a.txt?' }] },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'call_1', name: 'Read', arguments: { file_path: 'a.txt' } }] },
      { role: 'tool', parts: [{ type: 'tool_call_response', id: 'call_1', response: 'file text' }] },
    ]);
    expect(JSON.parse(String(attributes['gen_ai.output.messages']))).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'the answer' }], finish_reason: 'stop' },
    ]);
    expect(JSON.parse(String(attributes['gen_ai.tool.definitions']))).toEqual([{ type: 'function', name: 'Read', description: 'Read a file', parameters: { type: 'object' } }]);
  });
});
