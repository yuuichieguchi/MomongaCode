import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createTelemetry } from '@momonga/observability';
import { createAnthropicAdapter, createOpenResponsesAdapter } from '@momonga/gateway';
import type { ProviderAdapter } from '@momonga/gateway';
import { anthropicCountTokensReply, anthropicTextReply, createFakeClock, openResponsesTextReply, startFakeAnthropic, startFakeOpenResponses } from '@momonga/testkit';
import { START_MS, postJson, readJson, readSse, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import { makeAdapter, startFake } from './cc-support.ts';
import { textReply } from './cc-compact-support.ts';
import { chunkLine, doneLine, makeOllamaAdapter, startFakeOllama } from './ollama-support.ts';
import { FAKE_API_KEY, REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';
import { UNDICI_DEFAULT_LIVENESS } from '@momonga/testkit';

type Upstream = { adapter: ProviderAdapter; sent: () => number };

const REPLIES = 2;

const openResponses = async (): Promise<Upstream> => {
  const fake = await startFakeOpenResponses({ script: Array.from({ length: REPLIES }, () => openResponsesTextReply(['ok'])) });
  registerCleanup(() => fake.close());
  const adapter = createOpenResponsesAdapter({ liveness: UNDICI_DEFAULT_LIVENESS,
    resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
    capabilities: async () => REMOTE_CAPABILITIES,
    clock: createFakeClock(START_MS),
  });
  registerCleanup(() => adapter.close());
  return { adapter, sent: () => fake.requests.length };
};

const chatCompletions = (mode: 'native' | 'constrained') => async (): Promise<Upstream> => {
  const fake = await startFake({ scenario: mode === 'native' ? 'tools-ok' : 'json-schema-only', script: Array.from({ length: REPLIES }, () => textReply('ok')) });
  return { adapter: makeAdapter(fake, {}, mode), sent: () => fake.requests.length };
};

const COUNT_PATH = '/v1/momonga/count_tokens';

const anthropic = async (path: string): Promise<Upstream> => {
  const reply = () => (path === COUNT_PATH ? anthropicCountTokensReply(7) : anthropicTextReply(['ok']));
  const fake = await startFakeAnthropic({ apiKey: FAKE_API_KEY, script: Array.from({ length: REPLIES }, reply) });
  registerCleanup(() => fake.close());
  const adapter = createAnthropicAdapter({ liveness: UNDICI_DEFAULT_LIVENESS,
    resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
    apiKey: async () => FAKE_API_KEY,
    capabilities: async () => REMOTE_CAPABILITIES,
    clock: createFakeClock(START_MS),
    apiVersion: '2026-10-21',
  });
  registerCleanup(() => adapter.close());
  return { adapter, sent: () => fake.requests.length };
};

const ollama = async (): Promise<Upstream> => {
  const fake = await startFakeOllama({ chat: Array.from({ length: REPLIES }, () => ({ kind: 'ndjson' as const, lines: [chunkLine({ content: 'ok' }), doneLine()] })) });
  return { adapter: makeOllamaAdapter(fake), sent: () => fake.requests.filter((request) => request.path === '/api/chat' || request.path.endsWith('/chat/completions')).length };
};

const KINDS: { kind: string; start: (path: string) => Promise<Upstream> }[] = [
  { kind: 'open-responses', start: openResponses },
  { kind: 'chat-completions native', start: chatCompletions('native') },
  { kind: 'chat-completions constrained', start: chatCompletions('constrained') },
  { kind: 'anthropic', start: anthropic },
  { kind: 'ollama', start: ollama },
];

const OPERATIONS = [
  { operation: 'create', path: '/v1/responses', stream: false },
  { operation: 'create streaming', path: '/v1/responses', stream: true },
  { operation: 'count_tokens', path: COUNT_PATH, stream: false },
];

const tracedGatewayOf = async (adapter: ProviderAdapter) => {
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
  const harness = await startGateway({
    clock,
    telemetry,
    adapters: { only: adapter },
    config: { aliases: { fast: ['only'] }, targets: { only: { model: 'system' } }, retry: { maxAttempts: 1, totalWaitMs: 1 } },
  });
  const attemptSpans = async () => {
    await telemetry.forceFlush();
    return memory.getFinishedSpans().filter((span) => span.attributes['gen_ai.operation.name'] === 'chat');
  };
  return { harness, attemptSpans };
};

const toolNamed = (name: string) => ({ type: 'function' as const, name, parameters: { type: 'object', properties: {}, additionalProperties: false } });

const UNSATISFIABLE = [
  { choice: 'required without tools', fields: { tool_choice: 'required' }, param: 'tool_choice' },
  { choice: 'a function absent from tools', fields: { tools: [toolNamed('a'), toolNamed('b')], tool_choice: { type: 'function', name: 'c' } }, param: 'tool_choice.name' },
  { choice: 'a function without tools', fields: { tool_choice: { type: 'function', name: 'c' } }, param: 'tool_choice.name' },
];

const UNSATISFIABLE_CASES = KINDS.flatMap((kind) => OPERATIONS.flatMap((operation) => UNSATISFIABLE.map((choice) => ({ ...kind, ...operation, ...choice }))));

const GUARD_CASES = KINDS.flatMap((kind) =>
  OPERATIONS.flatMap((operation) => ['none', 'auto'].map((toolChoice) => ({ ...kind, ...operation, toolChoice }))),
);

describe('a constraining tool_choice the request tools cannot satisfy is an invalid request in validation', () => {
  it.for(UNSATISFIABLE_CASES)('$kind $operation with $choice: 400 invalid_request at $param, nothing sent, no attempt span', async (testCase) => {
    const upstream = await testCase.start(testCase.path);
    const { harness, attemptSpans } = await tracedGatewayOf(upstream.adapter);
    const body = { model: 'fast', input: userInput('hi'), ...testCase.fields, ...(testCase.stream ? { stream: true } : {}) };
    const raw = await postJson(harness.client, testCase.path, body);
    const response = testCase.stream && raw.status === 200 ? { status: raw.status, body: { frames: await readSse(raw) } as any } : await readJson(raw);
    expect({ status: response.status, code: response.body.error?.code, param: response.body.error?.param }).toEqual({
      status: 400,
      code: 'invalid_request',
      param: testCase.param,
    });
    expect(upstream.sent()).toBe(0);
    expect(await attemptSpans()).toHaveLength(0);
  });

  it.for(GUARD_CASES)('$kind $operation with tool_choice $toolChoice and no tools still succeeds', async (testCase) => {
    const upstream = await testCase.start(testCase.path);
    const { harness } = await tracedGatewayOf(upstream.adapter);
    const body = { model: 'fast', input: userInput('hi'), tool_choice: testCase.toolChoice, ...(testCase.stream ? { stream: true } : {}) };
    const response = await postJson(harness.client, testCase.path, body);
    if (testCase.stream) {
      const frames = await readSse(response);
      expect(frames.at(-1)?.data?.type).toBe('response.completed');
      return;
    }
    const read = await readJson(response);
    expect(read.body.error ?? null).toBeNull();
    expect(read.status).toBe(200);
  });
});

describe('the tool_choice refusal names the choice the client sent', () => {
  it('a named function refused by ollama is reported as that function, not as required', async () => {
    const upstream = await ollama();
    const { harness } = await tracedGatewayOf(upstream.adapter);
    const response = await readJson(
      await postJson(harness.client, '/v1/responses', { model: 'fast', input: userInput('hi'), tools: [toolNamed('a')], tool_choice: { type: 'function', name: 'a' } }),
    );
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe('unsupported_tool_choice');
    const message = String(response.body.error?.message);
    expect(message).not.toContain('tool_choice required');
    expect(message).toMatch(/function/);
    expect(message).toContain('"a"');
    expect(upstream.sent()).toBe(0);
  });
});
