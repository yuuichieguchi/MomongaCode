import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents, usageOf, waitFor } from '@momonga/testkit';
import { expectErrorBody, getJson, outputText, postJson, readJson, readSse, startGateway, userInput, validator } from './gateway-helpers.ts';

const TOOLS = [
  {
    type: 'function',
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    strict: true,
  },
];

const twoTargets = {
  aliases: { fast: ['a', 'b'] },
  targets: { a: { adapter: 'a', model: 'model-a' }, b: { adapter: 'b', model: 'model-b' } },
};

describe('router fallback', () => {
  it('falls back to the next target when the first fails before its first event and its retries are exhausted', async () => {
    const a = createScriptedAdapter({
      calls: [{ failure: { status: 503, message: 'a down' } }, { failure: { status: 503, message: 'a still down' } }],
    });
    const b = createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'model-b', chunks: ['from b'] }) }] });
    const { client, timers } = await startGateway({ adapters: { a, b }, config: { ...twoTargets, retry: { maxAttempts: 2 } } });
    const pending = postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi') });
    await waitFor(() => a.calls.length === 1 && timers.pending().length > 0, { description: 'backoff before retry on a' });
    timers.advance(timers.pending().at(-1)?.delayMs ?? 0);
    const response = await readJson(await pending);

    expect(response.status).toBe(200);
    expect(a.calls).toHaveLength(2);
    expect(b.calls).toHaveLength(1);
    expect(outputText(response.body)).toBe('from b');
    expect(response.body.model).toBe('model-b');
    expect(response.body.momonga).toEqual({ alias: 'fast', target: 'b', attempts: 3, fallbackFrom: ['a'], usageSource: 'reported' });
    expect(b.calls[0]?.request.model).toBe('model-b');
  });

  it('does not fall back on a non-retryable upstream error and returns it to the client', async () => {
    const a = createScriptedAdapter({ calls: [{ failure: { status: 400, message: 'context too long' } }] });
    const b = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { a, b }, config: twoTargets });
    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
    expect(response.status).toBe(400);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'upstream_rejected' });
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
  });

  it('ends the stream with response.failed stream_interrupted when the target fails after the first event, without fallback', async () => {
    const aEvents = textResponseEvents({ model: 'model-a', chunks: ['partial ', 'answer'] });
    const a = createScriptedAdapter({ calls: [{ events: aEvents.slice(0, 5), failure: { status: 503, message: 'connection reset' } }] });
    const b = createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'model-b', chunks: ['from b'] }) }] });
    const { client } = await startGateway({ adapters: { a, b }, config: twoTargets });
    const frames = await readSse(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), stream: true }));

    expect(b.calls).toHaveLength(0);
    expect(a.calls).toHaveLength(1);
    const last = frames.at(-1)?.data;
    expect(last.type).toBe('response.failed');
    expect(validator.validate('ResponseFailedStreamingEvent', last).errors).toEqual([]);
    expect(last.response.status).toBe('failed');
    expect(last.response.error.code).toBe('stream_interrupted');
    expect(last.response.error.message.length).toBeGreaterThan(0);
    expect(frames.filter((frame) => ['response.completed', 'response.failed', 'response.incomplete'].includes(frame.data.type))).toHaveLength(1);
    const deltas = frames.filter((frame) => frame.data.type === 'response.output_text.delta').map((frame) => frame.data.delta);
    expect(deltas).toEqual(['partial ']);
    expect(JSON.stringify(frames)).not.toContain('from b');
    const sequence = frames.map((frame) => frame.data.sequence_number as number);
    for (let index = 1; index < sequence.length; index += 1) expect(sequence[index]).toBeGreaterThan(sequence[index - 1] as number);
  });
});

describe('capability filter', () => {
  it('skips targets whose toolCalling is none when the request has tools', async () => {
    const plain = createScriptedAdapter({ calls: [], capabilities: { toolCalling: 'none' } });
    const tooled = createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'model-t', chunks: ['ok'] }) }] });
    const { client } = await startGateway({
      adapters: { plain, tooled },
      config: {
        aliases: { fast: ['plain', 'tooled'] },
        targets: { plain: { adapter: 'plain', model: 'model-p' }, tooled: { adapter: 'tooled', model: 'model-t' } },
      },
    });
    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), tools: TOOLS }));
    expect(response.status).toBe(200);
    expect(plain.calls).toHaveLength(0);
    expect(tooled.calls).toHaveLength(1);
    expect(tooled.calls[0]?.request.tools).toEqual(TOOLS);
    expect(response.body.momonga.target).toBe('tooled');
    expect(response.body.momonga.fallbackFrom).toBeUndefined();
  });

  it('applies the config capability override over the adapter declaration when filtering', async () => {
    const declaredNative = createScriptedAdapter({ calls: [], capabilities: { toolCalling: 'native' } });
    const { client } = await startGateway({
      adapters: { declaredNative },
      config: {
        aliases: { fast: ['only'] },
        targets: { only: { adapter: 'declaredNative', model: 'model-o', capabilities: { toolCalling: 'none' } } },
      },
    });
    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), tools: TOOLS }));
    expect(response.status).toBe(400);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'capability_unsupported', param: 'tools' });
    expect(declaredNative.calls).toHaveLength(0);
  });

  it('returns 400 capability_unsupported when no target of the alias supports tools', async () => {
    const plain = createScriptedAdapter({ calls: [], capabilities: { toolCalling: 'none' } });
    const { client } = await startGateway({
      adapters: { plain },
      config: { aliases: { fast: ['plain'] }, targets: { plain: { adapter: 'plain', model: 'model-p' } } },
    });
    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), tools: TOOLS }));
    expect(response.status).toBe(400);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'capability_unsupported', param: 'tools' });
    expect(response.body.error.message).toContain('fast');
  });

  it('serves a request without tools from a target whose toolCalling is none', async () => {
    const plain = createScriptedAdapter({
      calls: [{ events: textResponseEvents({ model: 'model-p', chunks: ['fine'], usage: usageOf(1, 1) }) }],
      capabilities: { toolCalling: 'none' },
    });
    const { client } = await startGateway({
      adapters: { plain },
      config: { aliases: { fast: ['plain'] }, targets: { plain: { adapter: 'plain', model: 'model-p' } } },
    });
    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('fine');
    expect((await getJson(client, '/v1/momonga/health')).status).toBe(200);
  });
});
