import http from 'node:http';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FAKE_DETERMINISTIC_REPLY,
  FAKE_GUARDRAIL_ERROR,
  FAKE_PAYLOAD_TOO_LARGE_ERROR,
  countFakeRequestTokens,
  countFakeTokens,
  fakeUsageOfRequest,
  generateInstance,
  isValidAtIndex,
  startFakeChatCompletions,
  waitFor,
  type FakeChatCompletionsOptions,
  type FakeChatCompletionsServer,
} from '@momonga/testkit';

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

const send = (socketPath: string, method: string, path: string, body?: unknown): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      { socketPath, method, path, headers: payload === undefined ? {} : { 'content-type': 'application/json' } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }),
        );
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end(payload);
  });

const json = (response: RawResponse): any => JSON.parse(response.text);

const servers: FakeChatCompletionsServer[] = [];
const start = async (options: FakeChatCompletionsOptions): Promise<FakeChatCompletionsServer> => {
  const server = await startFakeChatCompletions(options);
  servers.push(server);
  return server;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const weatherTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the weather',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' }, days: { type: 'integer', minimum: 1 } },
      required: ['city', 'days'],
      additionalProperties: false,
    },
  },
};

const otherTool = {
  type: 'function',
  function: { name: 'get_time', parameters: { type: 'object', properties: { zone: { type: 'string' } }, required: ['zone'] } },
};

const askWeather = { role: 'user', content: 'Please call get_weather for Tokyo' };

const chat = (socketPath: string, body: Record<string, unknown>): Promise<RawResponse> =>
  send(socketPath, 'POST', '/v1/chat/completions', { model: 'system', ...body });

const ajv = new Ajv2020.default({ strict: false });
const validWeatherArgs = ajv.compile(weatherTool.function.parameters);

const envelopeSchema = {
  type: 'object',
  anyOf: [
    {
      type: 'object',
      properties: { kind: { const: 'final' }, text: { type: 'string' } },
      required: ['kind', 'text'],
    },
    {
      type: 'object',
      properties: {
        kind: { const: 'tool_calls' },
        calls: {
          type: 'array',
          minItems: 1,
          maxItems: 1,
          items: {
            anyOf: [
              {
                type: 'object',
                properties: { name: { const: 'get_time' }, arguments: otherTool.function.parameters },
                required: ['name', 'arguments'],
              },
              {
                type: 'object',
                properties: { name: { const: 'get_weather' }, arguments: weatherTool.function.parameters },
                required: ['name', 'arguments'],
              },
            ],
          },
        },
      },
      required: ['kind', 'calls'],
    },
  ],
};
const validEnvelope = ajv.compile(envelopeSchema);
const jsonSchemaFormat = (schema: unknown) => ({ type: 'json_schema', json_schema: { name: 'out', strict: true, schema } });

const parseSse = (text: string): string[] =>
  text
    .split('\n\n')
    .filter((block) => block.length > 0)
    .map((block) => {
      expect(block.startsWith('data: ')).toBe(true);
      return block.slice('data: '.length);
    });

describe('isValidAtIndex', () => {
  it.each([
    [1, 10],
    [0, 0],
    [0.5, 5],
    [0.7, 7],
    [0.9, 9],
  ])('rate %f yields %i valid out of any 10 consecutive requests', (rate, expected) => {
    for (const offset of [0, 3, 10]) {
      const valid = Array.from({ length: 10 }, (_, i) => isValidAtIndex(offset + i, rate)).filter(Boolean).length;
      expect(valid).toBe(expected);
    }
  });
});

describe('generateInstance', () => {
  it('produces an instance that validates against the weather schema', () => {
    expect(validWeatherArgs(generateInstance(weatherTool.function.parameters))).toBe(true);
  });

  it('chooses the tool_calls branch and the requested tool name', () => {
    const instance = generateInstance(envelopeSchema, { requiredToolName: 'get_weather' }) as any;
    expect(validEnvelope(instance)).toBe(true);
    expect(instance.kind).toBe('tool_calls');
    expect(instance.calls[0].name).toBe('get_weather');
    expect(validWeatherArgs(instance.calls[0].arguments)).toBe(true);
  });

  it('chooses the final branch when no tool is required', () => {
    const instance = generateInstance(envelopeSchema) as any;
    expect(instance.kind).toBe('final');
    expect(typeof instance.text).toBe('string');
  });

  it('honours enum, const, minItems and nested objects', () => {
    const schema = {
      type: 'object',
      properties: {
        color: { enum: ['red', 'blue'] },
        fixed: { const: 42 },
        tags: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3 },
        inner: { type: 'object', properties: { flag: { type: 'boolean' }, score: { type: 'number', minimum: 5 } } },
      },
    };
    expect(generateInstance(schema)).toEqual({
      color: 'red',
      fixed: 42,
      tags: ['value', 'value'],
      inner: { flag: true, score: 5 },
    });
  });
});

describe('startFakeChatCompletions endpoints', () => {
  it('reports health and models with the default model id and no context size', async () => {
    const fake = await start({ scenario: 'tools-ok' });
    const health = await send(fake.socketPath, 'GET', '/health');
    expect(health.status).toBe(200);
    expect(json(health)).toEqual({ status: 'ok' });
    const models = json(await send(fake.socketPath, 'GET', '/v1/models'));
    expect(models.object).toBe('list');
    expect(models.data).toHaveLength(1);
    expect(models.data[0].id).toBe('system');
    expect(models.data[0].object).toBe('model');
    expect(models.data[0].context_window).toBeUndefined();
  });

  it('exposes context_window on the models entry', async () => {
    const fake = await start({ scenario: 'tools-ok', contextWindow: 8192, contextSizeExposure: 'models', modelId: 'm1' });
    const models = json(await send(fake.socketPath, 'GET', '/v1/models'));
    expect(models.data[0]).toMatchObject({ id: 'm1', context_window: 8192 });
    expect(json(await send(fake.socketPath, 'GET', '/health')).context_window).toBeUndefined();
  });

  it('exposes context_window on health', async () => {
    const fake = await start({ scenario: 'tools-ok', contextWindow: 2048, contextSizeExposure: 'health' });
    expect(json(await send(fake.socketPath, 'GET', '/health'))).toEqual({ status: 'ok', context_window: 2048 });
  });

  it('answers 503 on health when unhealthy', async () => {
    const fake = await start({ scenario: 'tools-ok', healthy: false });
    expect((await send(fake.socketPath, 'GET', '/health')).status).toBe(503);
  });

  it('records every request', async () => {
    const fake = await start({ scenario: 'tools-ok' });
    await send(fake.socketPath, 'GET', '/health');
    await chat(fake.socketPath, { messages: [{ role: 'user', content: 'hi' }] });
    expect(fake.requests.map((request) => [request.method, request.path])).toEqual([
      ['GET', '/health'],
      ['POST', '/v1/chat/completions'],
    ]);
    expect(fake.requests[1]?.body).toEqual({ model: 'system', messages: [{ role: 'user', content: 'hi' }] });
    expect(fake.requests[1]?.headers['content-type']).toBe('application/json');
  });

  it('creates its socket inside a 0700 directory with a short path', async () => {
    const { statSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const fake = await start({ scenario: 'none' });
    expect(Buffer.byteLength(fake.socketPath)).toBeLessThan(104);
    expect(statSync(dirname(fake.socketPath)).mode & 0o777).toBe(0o700);
  });
});

describe('plain completions and usage', () => {
  it('returns a deterministic reply with usage computed by the estimator plus 4 per message', async () => {
    const fake = await start({ scenario: 'none' });
    const messages = [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'one two three' },
    ];
    const response = await chat(fake.socketPath, { messages });
    expect(response.status).toBe(200);
    const body = json(response);
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('system');
    expect(body.choices[0].message).toEqual({ role: 'assistant', content: FAKE_DETERMINISTIC_REPLY });
    expect(body.choices[0].finish_reason).toBe('stop');
    const promptTokens = countFakeRequestTokens({ messages });
    const completionTokens = Math.max(1, countFakeTokens(FAKE_DETERMINISTIC_REPLY));
    expect(body.usage).toEqual({ prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens });
  });

  it('counts the tools of the request in the prompt tokens', async () => {
    const fake = await start({ scenario: 'tools-ok' });
    const messages = [{ role: 'user', content: 'hello' }];
    const tools = [weatherTool];
    const withTools = json(await chat(fake.socketPath, { messages, tools }));
    const without = json(await chat(fake.socketPath, { messages }));
    expect(withTools.usage.prompt_tokens).toBe(countFakeRequestTokens({ messages, tools }));
    expect(withTools.usage.prompt_tokens).toBeGreaterThan(without.usage.prompt_tokens);
  });

  it('counts an image by the image model and not by the bytes of its data URL', async () => {
    const imageTokens = { pixelsPerToken: 750, maxTokens: 1600 };
    const fake = await start({ scenario: 'none', imageInput: true, imageTokens });
    const pngUrl = (padding: number): string => {
      const header = Buffer.alloc(24);
      header.writeUInt32BE(512, 16);
      header.writeUInt32BE(512, 20);
      return `data:image/png;base64,${header.toString('base64')}${'A'.repeat(padding)}`;
    };
    const messageWith = (padding: number) => ({ role: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'image_url', image_url: { url: pngUrl(padding) } }] });
    const small = json(await chat(fake.socketPath, { messages: [messageWith(8)] }));
    const large = json(await chat(fake.socketPath, { messages: [messageWith(40_000)] }));
    expect(large.usage.prompt_tokens).toBe(small.usage.prompt_tokens);
    expect(small.usage.prompt_tokens).toBe(countFakeRequestTokens({ messages: [messageWith(8)] }, imageTokens));
    expect(small.usage.prompt_tokens).toBeGreaterThanOrEqual(Math.ceil((512 * 512) / imageTokens.pixelsPerToken));
  });

  it('omits usage when usageReported is false', async () => {
    const fake = await start({ scenario: 'none', usageReported: false });
    const body = json(await chat(fake.socketPath, { messages: [{ role: 'user', content: 'x' }] }));
    expect(body.usage).toBeUndefined();
  });
});

describe('universal rejections', () => {
  it('rejects json_object with the fm message', async () => {
    const fake = await start({ scenario: 'tools-ok' });
    const response = await chat(fake.socketPath, {
      messages: [{ role: 'user', content: 'x' }],
      response_format: { type: 'json_object' },
    });
    expect(response.status).toBe(400);
    expect(json(response).error.message).toBe(
      "response_format type 'json_object' is not supported. Use 'json_schema' instead.",
    );
  });

  it('rejects stop unless stopSupported', async () => {
    const strict = await start({ scenario: 'tools-ok' });
    const rejected = await chat(strict.socketPath, { messages: [{ role: 'user', content: 'x' }], stop: ['END'] });
    expect(rejected.status).toBe(400);
    expect(json(rejected).error.message).toBe("stop sequences are not supported. Truncate the model's output client-side.");
    const lenient = await start({ scenario: 'tools-ok', stopSupported: true });
    expect((await chat(lenient.socketPath, { messages: [{ role: 'user', content: 'x' }], stop: ['END'] })).status).toBe(200);
  });

  it('rejects image input unless imageInput', async () => {
    const message = {
      role: 'user',
      content: [
        { type: 'text', text: 'describe' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    };
    const strict = await start({ scenario: 'tools-ok' });
    expect((await chat(strict.socketPath, { messages: [message] })).status).toBe(400);
    const lenient = await start({ scenario: 'tools-ok', imageInput: true });
    expect((await chat(lenient.socketPath, { messages: [message] })).status).toBe(200);
  });

  it('rejects guardrail triggers with the guardrail error shape', async () => {
    const fake = await start({ scenario: 'tools-ok', guardrailTrigger: 'FORBIDDEN-TOPIC' });
    const response = await chat(fake.socketPath, { messages: [{ role: 'user', content: 'tell me FORBIDDEN-TOPIC now' }] });
    expect(response.status).toBe(400);
    expect(json(response)).toEqual(FAKE_GUARDRAIL_ERROR);
    expect(FAKE_GUARDRAIL_ERROR.error.code).toBe('guardrail_violation');
    expect((await chat(fake.socketPath, { messages: [{ role: 'user', content: 'harmless' }] })).status).toBe(200);
  });

  it('rejects requests exceeding the context window with context_length_exceeded', async () => {
    const fake = await start({ scenario: 'none', contextWindow: 100 });
    const messages = [{ role: 'user', content: 'a b c d e f' }];
    const room = 100 - countFakeRequestTokens({ messages });
    expect((await chat(fake.socketPath, { messages, max_tokens: room })).status).toBe(200);
    const rejected = await chat(fake.socketPath, { messages, max_tokens: room + 1 });
    expect(rejected.status).toBe(400);
    expect(json(rejected).error.code).toBe('context_length_exceeded');
  });

  it('answers 429 with Retry-After when concurrency is exceeded', async () => {
    const fake = await start({ scenario: 'none', latencyMs: 80, maxConcurrency: 2 });
    const body = { messages: [{ role: 'user', content: 'x' }] };
    const responses = await Promise.all([chat(fake.socketPath, body), chat(fake.socketPath, body), chat(fake.socketPath, body)]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 200, 429]);
    const limited = responses.find((response) => response.status === 429);
    expect(limited?.headers['retry-after']).toBe('1');
  });

  it('defaults maxConcurrency to 1', async () => {
    const fake = await start({ scenario: 'none', latencyMs: 80 });
    const body = { messages: [{ role: 'user', content: 'x' }] };
    const statuses = (await Promise.all([chat(fake.socketPath, body), chat(fake.socketPath, body)])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 429]);
  });
});

describe('scenarios', () => {
  it('tools-ok returns tool_calls for the requested tool and accepts a tool-role follow-up', async () => {
    const fake = await start({ scenario: 'tools-ok' });
    const first = json(await chat(fake.socketPath, { messages: [askWeather], tools: [otherTool, weatherTool] }));
    const call = first.choices[0].message.tool_calls[0];
    expect(first.choices[0].finish_reason).toBe('tool_calls');
    expect(call.type).toBe('function');
    expect(call.function.name).toBe('get_weather');
    expect(validWeatherArgs(JSON.parse(call.function.arguments))).toBe(true);
    const followUp = await chat(fake.socketPath, {
      tools: [otherTool, weatherTool],
      messages: [
        askWeather,
        { role: 'assistant', content: null, tool_calls: [call] },
        { role: 'tool', tool_call_id: call.id, content: 'sunny 25C' },
      ],
    });
    expect(followUp.status).toBe(200);
    const message = json(followUp).choices[0].message;
    expect(message.tool_calls).toBeUndefined();
    expect(message.content).toBe('Tool result received: sunny 25C');
  });

  it('tools-ok answers plain text when the prompt names no tool', async () => {
    const fake = await start({ scenario: 'tools-ok' });
    const body = json(await chat(fake.socketPath, { messages: [{ role: 'user', content: 'hello' }], tools: [weatherTool] }));
    expect(body.choices[0].message.content).toBe(FAKE_DETERMINISTIC_REPLY);
    expect(body.choices[0].message.tool_calls).toBeUndefined();
  });

  it.each(['tools-400', 'json-schema-only', 'none'] as const)('%s rejects tools with 400', async (scenario) => {
    const fake = await start({ scenario });
    const response = await chat(fake.socketPath, { messages: [askWeather], tools: [weatherTool] });
    expect(response.status).toBe(400);
    expect(json(response).error.type).toBe('invalid_request_error');
  });

  it('tools-ignored accepts tools but never returns tool_calls', async () => {
    const fake = await start({ scenario: 'tools-ignored' });
    const response = await chat(fake.socketPath, { messages: [askWeather], tools: [weatherTool] });
    expect(response.status).toBe(200);
    expect(json(response).choices[0].message.tool_calls).toBeUndefined();
    expect(json(response).choices[0].message.content).toBe(FAKE_DETERMINISTIC_REPLY);
  });

  it.each(['tools-ok', 'tools-400', 'tools-ignored', 'json-schema-only'] as const)(
    '%s accepts json_schema and returns a valid envelope with the requested tool',
    async (scenario) => {
      const fake = await start({ scenario });
      const response = await chat(fake.socketPath, { messages: [askWeather], response_format: jsonSchemaFormat(envelopeSchema) });
      expect(response.status).toBe(200);
      const content = JSON.parse(json(response).choices[0].message.content);
      expect(validEnvelope(content)).toBe(true);
      expect(content.kind).toBe('tool_calls');
      expect(content.calls[0].name).toBe('get_weather');
    },
  );

  it('none rejects json_schema', async () => {
    const fake = await start({ scenario: 'none' });
    const response = await chat(fake.socketPath, { messages: [askWeather], response_format: jsonSchemaFormat(envelopeSchema) });
    expect(response.status).toBe(400);
  });

  it('rejects schemas using unsupported keywords', async () => {
    const fake = await start({ scenario: 'tools-ok', unsupportedKeywords: ['pattern', 'nested'] });
    const ask = (schema: unknown) =>
      chat(fake.socketPath, { messages: [{ role: 'user', content: 'x' }], response_format: jsonSchemaFormat(schema) });
    expect((await ask({ type: 'object', properties: { a: { type: 'string', pattern: '^a' } } })).status).toBe(400);
    expect(
      (await ask({ type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } } } } })).status,
    ).toBe(400);
    expect((await ask({ type: 'object', properties: { pattern: { type: 'string', enum: ['x'] } } })).status).toBe(200);
  });
});

describe('validity rates', () => {
  it('native validity 0.5 yields exactly 5 valid tool calls out of 10, invalid ones malformed or wrongly typed', async () => {
    const fake = await start({ scenario: 'tools-ok', nativeValidity: 0.5 });
    let valid = 0;
    for (let i = 0; i < 10; i += 1) {
      const body = json(await chat(fake.socketPath, { messages: [askWeather], tools: [weatherTool] }));
      const call = body.choices[0].message.tool_calls[0];
      expect(call.function.name).toBe('get_weather');
      let parsed: unknown;
      try {
        parsed = JSON.parse(call.function.arguments);
      } catch {
        continue;
      }
      if (validWeatherArgs(parsed)) valid += 1;
    }
    expect(valid).toBe(5);
  });

  it('constrained validity 0.7 yields exactly 7 valid envelopes out of 10', async () => {
    const fake = await start({ scenario: 'tools-400', constrainedValidity: 0.7 });
    let valid = 0;
    for (let i = 0; i < 10; i += 1) {
      const body = json(
        await chat(fake.socketPath, { messages: [askWeather], response_format: jsonSchemaFormat(envelopeSchema) }),
      );
      let parsed: any;
      try {
        parsed = JSON.parse(body.choices[0].message.content);
      } catch {
        continue;
      }
      if (validEnvelope(parsed) && (parsed as any).calls[0].name === 'get_weather') valid += 1;
    }
    expect(valid).toBe(7);
  });

  it('non-tool json_schema requests do not consume the constrained validity sequence', async () => {
    const fake = await start({ scenario: 'tools-400', constrainedValidity: 0 });
    const body = json(
      await chat(fake.socketPath, {
        messages: [{ role: 'user', content: 'no tool here' }],
        response_format: jsonSchemaFormat({ type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] }),
      }),
    );
    expect(JSON.parse(body.choices[0].message.content)).toEqual({ a: 1 });
  });
});

describe('streaming', () => {
  it('streams content chunks and ends with [DONE] without usage by default', async () => {
    const fake = await start({ scenario: 'none' });
    const response = await chat(fake.socketPath, {
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(response.headers['content-type']).toContain('text/event-stream');
    const events = parseSse(response.text);
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events.slice(0, -1).map((event) => JSON.parse(event));
    expect(chunks.every((chunk) => chunk.object === 'chat.completion.chunk')).toBe(true);
    expect(chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? '').join('')).toBe(FAKE_DETERMINISTIC_REPLY);
    expect(chunks.some((chunk) => chunk.usage !== undefined)).toBe(false);
    expect(chunks.at(-1).choices[0].finish_reason).toBe('stop');
  });

  it('includes a usage chunk only with include_usage and streamUsage', async () => {
    const fake = await start({ scenario: 'none', streamUsage: true });
    const withUsage = parseSse(
      (await chat(fake.socketPath, { messages: [{ role: 'user', content: 'x' }], stream: true, stream_options: { include_usage: true } })).text,
    );
    const usageChunk = JSON.parse(withUsage.at(-2) as string);
    expect(usageChunk.choices).toEqual([]);
    const promptTokens = countFakeRequestTokens({ messages: [{ role: 'user', content: 'x' }] });
    const completionTokens = Math.max(1, countFakeTokens(FAKE_DETERMINISTIC_REPLY));
    expect(usageChunk.usage).toEqual({ prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens });
    const without = parseSse((await chat(fake.socketPath, { messages: [{ role: 'user', content: 'x' }], stream: true })).text);
    expect(without.slice(0, -1).some((event) => JSON.parse(event).usage !== undefined)).toBe(false);
  });

  it('splits tool_call arguments across chunks', async () => {
    const fake = await start({ scenario: 'tools-ok' });
    const events = parseSse((await chat(fake.socketPath, { messages: [askWeather], tools: [weatherTool], stream: true })).text);
    const fragments = events
      .slice(0, -1)
      .map((event) => JSON.parse(event))
      .flatMap((chunk) => chunk.choices[0]?.delta?.tool_calls ?? []);
    expect(fragments.length).toBeGreaterThanOrEqual(2);
    expect(fragments[0].function.name).toBe('get_weather');
    const args = fragments.map((fragment: any) => fragment.function.arguments).join('');
    expect(validWeatherArgs(JSON.parse(args))).toBe(true);
  });
});

describe('probe support options', () => {
  const plainBody = { messages: [{ role: 'user', content: 'x' }] };
  const toolBody = { messages: [askWeather], tools: [weatherTool] };

  it('queues requests instead of answering 429 when overflow is queue', async () => {
    const fake = await start({ scenario: 'none', latencyMs: 40, maxConcurrency: 1, overflow: 'queue' });
    const responses = await Promise.all([1, 2, 3].map(() => chat(fake.socketPath, plainBody)));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
  });

  it('answers 413 for oversized prompts when contextOverflowStatus is 413', async () => {
    const fake = await start({ scenario: 'none', contextWindow: 5, contextOverflowStatus: 413 });
    const response = await chat(fake.socketPath, { messages: [{ role: 'user', content: 'a b c d e f g h' }] });
    expect(response.status).toBe(413);
    expect(json(response)).toEqual(FAKE_PAYLOAD_TOO_LARGE_ERROR);
  });

  it('answers 500 for oversized prompts when contextOverflowStatus is 500', async () => {
    const fake = await start({ scenario: 'none', contextWindow: 5, contextOverflowStatus: 500 });
    const response = await chat(fake.socketPath, { messages: [{ role: 'user', content: 'a b c d e f g h' }] });
    expect(response.status).toBe(500);
  });

  it('exposes the context window in nested fields of models and health', async () => {
    const models = await start({ scenario: 'none', contextWindow: 123, contextSizeExposure: 'models-nested' });
    expect(json(await send(models.socketPath, 'GET', '/v1/models')).data[0].metadata.limits.contextSize).toBe(123);
    const health = await start({ scenario: 'none', contextWindow: 321, contextSizeExposure: 'health-nested' });
    expect(json(await send(health.socketPath, 'GET', '/health')).limits.context_size).toBe(321);
  });

  it('rejects the listed native samples with the guardrail error', async () => {
    const fake = await start({ scenario: 'tools-ok', failNativeSamples: [1] });
    const statuses = [];
    for (let index = 0; index < 3; index += 1) statuses.push((await chat(fake.socketPath, toolBody)).status);
    expect(statuses).toEqual([200, 400, 200]);
  });

  it('stalls the listed native samples and frees the slot when the client disconnects', async () => {
    const fake = await start({ scenario: 'tools-ok', stallNativeSamples: [0], stallMs: 10000, maxConcurrency: 1 });
    const stalled = new Promise<void>((resolve) => {
      const request = http.request(
        { socketPath: fake.socketPath, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
        () => resolve(),
      );
      request.on('error', () => resolve());
      request.end(JSON.stringify({ model: 'system', ...toolBody }));
      setTimeout(() => request.destroy(), 100);
    });
    await stalled;
    await vi.waitFor(async () => expect((await chat(fake.socketPath, plainBody)).status).toBe(200));
  });

  it('counts open connections', async () => {
    const fake = await start({ scenario: 'none' });
    expect(fake.openConnections()).toBe(0);
  });
});

const streamFrames = (text: string): string[] =>
  text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => frame.slice('data: '.length));

describe('scripted replies', () => {
  it('serves scripted stream chunks verbatim in order, then usage and [DONE], and records the request', async () => {
    const server = await start({
      scenario: 'tools-ok',
      script: [
        {
          kind: 'stream',
          chunks: [{ delta: { role: 'assistant', content: 'ab' } }, { delta: { content: 'c' } }, { delta: {}, finishReason: 'length' }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        },
      ],
    });
    const response = await send(server.socketPath, 'POST', '/v1/chat/completions', { model: 'system', messages: [], stream: true });
    expect(response.status).toBe(200);
    const frames = streamFrames(response.text);
    expect(frames.at(-1)).toBe('[DONE]');
    const payloads = frames.slice(0, -1).map((frame) => JSON.parse(frame));
    expect(payloads.map((payload) => payload.choices[0]?.delta ?? null)).toEqual([
      { role: 'assistant', content: 'ab' },
      { content: 'c' },
      {},
      null,
    ]);
    expect(payloads[2].choices[0].finish_reason).toBe('length');
    expect(payloads[3].usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    expect(server.requests).toHaveLength(1);
  });

  it('sizes the usage of a scripted reply from the request when the script gives a function of it', async () => {
    const server = await start({
      scenario: 'tools-ok',
      script: [{ kind: 'stream', chunks: [{ delta: { content: 'x' } }, { delta: {}, finishReason: 'stop' }], usage: (body) => fakeUsageOfRequest(body, 5) }],
    });
    const messages = [{ role: 'user', content: 'a request that is sized' }];
    const response = await send(server.socketPath, 'POST', '/v1/chat/completions', { model: 'system', messages, stream: true });
    const usage = streamFrames(response.text).slice(0, -1).map((frame) => JSON.parse(frame)).find((payload) => payload.usage !== undefined)?.usage;
    const promptTokens = countFakeRequestTokens({ messages });
    expect(usage).toEqual({ prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5 });
  });

  it('omits [DONE] when the scripted stream sets done to false', async () => {
    const server = await start({
      scenario: 'tools-ok',
      script: [{ kind: 'stream', chunks: [{ delta: { content: 'x' } }], done: false }],
    });
    const response = await send(server.socketPath, 'POST', '/v1/chat/completions', { model: 'system', messages: [], stream: true });
    expect(streamFrames(response.text).includes('[DONE]')).toBe(false);
    expect(streamFrames(response.text)).toHaveLength(1);
  });

  it('serves a scripted error with its status, body, and headers, then falls back to normal behaviour', async () => {
    const server = await start({
      scenario: 'tools-ok',
      script: [{ kind: 'error', status: 429, body: { error: { message: 'slow down' } }, headers: { 'retry-after': '2' } }],
    });
    const first = await send(server.socketPath, 'POST', '/v1/chat/completions', { model: 'system', messages: [{ role: 'user', content: 'hi' }] });
    expect(first.status).toBe(429);
    expect(first.headers['retry-after']).toBe('2');
    expect(json(first)).toEqual({ error: { message: 'slow down' } });
    const second = await send(server.socketPath, 'POST', '/v1/chat/completions', { model: 'system', messages: [{ role: 'user', content: 'hi' }] });
    expect(second.status).toBe(200);
    expect(json(second).choices[0].message.content).toBe(FAKE_DETERMINISTIC_REPLY);
  });

  it('holds a hanging stream open until the client disconnects and counts the disconnect', async () => {
    const server = await start({ scenario: 'tools-ok', script: [{ kind: 'hang', chunks: [{ delta: { content: 'partial' } }] }] });
    expect(server.disconnects()).toBe(0);
    const received = await new Promise<string>((resolve, reject) => {
      const request = http.request(
        { socketPath: server.socketPath, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
        (response) => {
          response.once('data', (chunk: Buffer) => {
            resolve(chunk.toString('utf8'));
            request.destroy();
          });
        },
      );
      request.on('error', () => undefined);
      request.once('error', reject);
      request.end(JSON.stringify({ model: 'system', messages: [], stream: true }));
    });
    expect(received).toContain('partial');
    await waitFor(() => server.disconnects() === 1);
    expect(server.disconnects()).toBe(1);
  });

  it('does not count completed responses as disconnects', async () => {
    const server = await start({ scenario: 'tools-ok' });
    await send(server.socketPath, 'POST', '/v1/chat/completions', { model: 'system', messages: [{ role: 'user', content: 'hi' }], stream: true });
    expect(server.disconnects()).toBe(0);
  });
});

describe('constrained replies after a rendered tool result', () => {
  const envelope = {
    type: 'object',
    anyOf: [
      { type: 'object', properties: { kind: { const: 'final' }, text: { type: 'string' } }, required: ['kind', 'text'] },
      {
        type: 'object',
        properties: {
          kind: { const: 'tool_calls' },
          calls: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: { name: { const: 'get_weather' }, arguments: { type: 'object' } },
              required: ['name', 'arguments'],
            },
          },
        },
        required: ['kind', 'calls'],
      },
    ],
  };
  const responseFormat = { type: 'json_schema', json_schema: { name: 'envelope', schema: envelope, strict: true } };

  it('answers with a final envelope when the last user message is a <tool_result> block naming a tool', async () => {
    const server = await start({ scenario: 'json-schema-only' });
    const response = await send(server.socketPath, 'POST', '/v1/chat/completions', {
      model: 'system',
      response_format: responseFormat,
      messages: [{ role: 'user', content: '<tool_result call_id="c1" name="get_weather">sunny</tool_result>' }],
    });
    expect(JSON.parse(json(response).choices[0].message.content).kind).toBe('final');
  });

  it('still answers with a tool call when a plain user message names the tool', async () => {
    const server = await start({ scenario: 'json-schema-only' });
    const response = await send(server.socketPath, 'POST', '/v1/chat/completions', {
      model: 'system',
      response_format: responseFormat,
      messages: [{ role: 'user', content: 'please use get_weather' }],
    });
    expect(JSON.parse(json(response).choices[0].message.content)).toMatchObject({ kind: 'tool_calls', calls: [{ name: 'get_weather' }] });
  });
});
