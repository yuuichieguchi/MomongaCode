import { describe, expect, it } from 'vitest';
import { createAnthropicAdapter, createOpenResponsesAdapter } from '@momonga/gateway';
import type { ProviderAdapter } from '@momonga/protocol';
import {
  anthropicCountTokensReply,
  anthropicTextReply,
  createFakeClock,
  loadOpenResponsesSpec,
  openResponsesErrorReply,
  openResponsesTextReply,
  startFakeAnthropic,
  startFakeOpenResponses,
} from '@momonga/testkit';
import type { FakeUpstreamReply } from '@momonga/testkit';
import { CC_CAPABILITIES, completionBodies, makeAdapter, startFake } from './cc-support.ts';
import { OLLAMA_MODEL, chunkLine, doneLine, makeOllamaAdapter, startFakeOllama } from './ollama-support.ts';
import { START_MS, expectErrorBody, postJson, readJson, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import { FAKE_API_KEY, REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';

const OPEN = 'open-target';
const ANTHROPIC = 'anthropic-target';
const OLLAMA = 'ollama-target';
const CHAT_NATIVE = 'chat-native-target';
const CHAT_CONSTRAINED = 'chat-constrained-target';

const UNKNOWN = { top_k: 40, x_future: { a: 1 } };

type Upstream = { adapter: ProviderAdapter; sent: () => Array<Record<string, unknown>>; model: string };

const openUpstream = async (script: FakeUpstreamReply[]): Promise<Upstream> => {
  const fake = await startFakeOpenResponses({ script });
  registerCleanup(() => fake.close());
  const adapter = createOpenResponsesAdapter({
    resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
    capabilities: async () => REMOTE_CAPABILITIES,
    clock: createFakeClock(START_MS),
  });
  registerCleanup(() => adapter.close());
  return {
    adapter,
    model: 'upstream-model',
    sent: () => fake.requests.filter((request) => request.path === '/v1/responses').map((request) => request.body as Record<string, unknown>),
  };
};

const anthropicUpstream = async (): Promise<Upstream> => {
  const fake = await startFakeAnthropic({
    apiKey: FAKE_API_KEY,
    respond: (request) => (request.path === '/v1/messages/count_tokens' ? anthropicCountTokensReply(80) : anthropicTextReply(['from anthropic'])),
  });
  registerCleanup(() => fake.close());
  const adapter = createAnthropicAdapter({
    resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
    apiKey: async () => FAKE_API_KEY,
    capabilities: async () => REMOTE_CAPABILITIES,
    clock: createFakeClock(START_MS),
    apiVersion: '2026-10-21',
  });
  registerCleanup(() => adapter.close());
  return { adapter, model: 'upstream-model', sent: () => fake.requests.map((request) => request.body as Record<string, unknown>) };
};

const chatUpstream = async (toolCalling: 'native' | 'constrained'): Promise<Upstream> => {
  const reply = toolCalling === 'native' ? 'from chat' : '{"kind":"final","text":"from chat"}';
  const fake = await startFake({
    scenario: toolCalling === 'native' ? 'tools-ok' : 'json-schema-only',
    script: [{ kind: 'stream', chunks: [{ delta: { role: 'assistant', content: reply } }, { delta: {}, finishReason: 'stop' }] }],
  });
  const adapter = makeAdapter(fake, { toolCalling: () => toolCalling, capabilities: async () => ({ ...CC_CAPABILITIES, toolCalling }) });
  return { adapter, model: 'system', sent: () => completionBodies(fake) };
};

const ollamaUpstream = async (): Promise<Upstream> => {
  const fake = await startFakeOllama({ chat: [{ kind: 'ndjson', lines: [chunkLine({ content: 'from ollama' }), doneLine()] }] });
  return { adapter: makeOllamaAdapter(fake), model: OLLAMA_MODEL, sent: () => fake.chatBodies() };
};

const upstreamFor = (name: string, openScript: FakeUpstreamReply[]): Promise<Upstream> => {
  if (name === OPEN) return openUpstream(openScript);
  if (name === ANTHROPIC) return anthropicUpstream();
  if (name === OLLAMA) return ollamaUpstream();
  if (name === CHAT_NATIVE) return chatUpstream('native');
  return chatUpstream('constrained');
};

const TWO_OPEN_REPLIES = [openResponsesTextReply(['from open']), openResponsesTextReply(['from open'])];

const startAlias = async (order: readonly string[], options: { openScript?: FakeUpstreamReply[]; maxAttempts?: number } = {}) => {
  const upstreams: Record<string, Upstream> = {};
  for (const name of order) upstreams[name] = await upstreamFor(name, options.openScript ?? TWO_OPEN_REPLIES);
  const harness = await startGateway({
    adapters: Object.fromEntries(Object.entries(upstreams).map(([name, upstream]) => [name, upstream.adapter])),
    config: {
      aliases: { fast: [...order] },
      targets: Object.fromEntries(order.map((name) => [name, { model: (upstreams[name] as Upstream).model, kind: 'remote' }])),
      ...(options.maxAttempts === undefined ? {} : { retry: { maxAttempts: options.maxAttempts, totalWaitMs: 1 } }),
    },
  });
  const post = async (path: string, body: Record<string, unknown>) =>
    readJson(await postJson(harness.client, path, { model: 'fast', input: userInput('hi'), ...body }));
  return { post, sentTo: (name: string) => (upstreams[name] as Upstream).sent() };
};

const withoutKeys = (record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));

const expectUnknownParameter = (response: { status: number; body: any }, param: string, named: readonly string[]) => {
  expect(response.status).toBe(400);
  expectErrorBody(response.body, { type: 'invalid_request', code: 'unknown_parameter', param });
  for (const field of named) expect(String(response.body.error.message)).toContain(field);
  expect(String(response.body.error.message)).toContain('"fast"');
};

describe('an open-responses target carries unknown create fields to its upstream unchanged', () => {
  it('sends top_k and x_future as given, maps every known field as without them, and echoes neither', async () => {
    const plain = await startAlias([OPEN]);
    const baseline = await plain.post('/v1/responses', {});
    const carrying = await startAlias([OPEN]);
    const response = await carrying.post('/v1/responses', UNKNOWN);

    expect(baseline.status).toBe(200);
    expect(response.status).toBe(200);
    const sent = carrying.sentTo(OPEN);
    expect(sent).toHaveLength(1);
    expect((sent[0] as Record<string, unknown>)['top_k']).toBe(40);
    expect((sent[0] as Record<string, unknown>)['x_future']).toEqual({ a: 1 });
    expect(withoutKeys(sent[0] as Record<string, unknown>, ['top_k', 'x_future'])).toEqual(plain.sentTo(OPEN)[0]);
    expect(Object.keys(response.body)).not.toContain('top_k');
    expect(Object.keys(response.body)).not.toContain('x_future');
    expect(Object.keys(response.body).sort()).toEqual(Object.keys(baseline.body).sort());
  });
});

describe('a single target that does not pass unknown fields through refuses them before any upstream request', () => {
  it.for([ANTHROPIC, CHAT_NATIVE, CHAT_CONSTRAINED, OLLAMA])('answers %s with 400 unknown_parameter naming top_k', async (target) => {
    const alias = await startAlias([target]);
    const response = await alias.post('/v1/responses', { top_k: 40 });
    expectUnknownParameter(response, 'top_k', ['top_k']);
    expect(alias.sentTo(target)).toEqual([]);
  });

  it('sets param to the first unknown field in body order and names every unknown field', async () => {
    const alias = await startAlias([ANTHROPIC]);
    const response = await alias.post('/v1/responses', { b_field: 1, a_field: 2 });
    expectUnknownParameter(response, 'b_field', ['b_field', 'a_field']);
    expect(alias.sentTo(ANTHROPIC)).toEqual([]);
  });
});

describe('unknown fields narrow the candidates of a multi-target alias', () => {
  it('serves top_k from the open-responses target when the anthropic target comes first, sending nothing to anthropic', async () => {
    const alias = await startAlias([ANTHROPIC, OPEN]);
    const response = await alias.post('/v1/responses', { top_k: 40 });
    expect(response.status).toBe(200);
    expect(alias.sentTo(ANTHROPIC)).toEqual([]);
    expect(alias.sentTo(OPEN)).toHaveLength(1);
    expect((alias.sentTo(OPEN)[0] as Record<string, unknown>)['top_k']).toBe(40);
  });

  it('does not fall back to anthropic when the open-responses target fails retryably before output: 502 upstream_error', async () => {
    const alias = await startAlias([OPEN, ANTHROPIC], {
      openScript: [openResponsesErrorReply(503, 'server_error', null, 'open target is down')],
      maxAttempts: 1,
    });
    const response = await alias.post('/v1/responses', { top_k: 40 });
    expect(response.status).toBe(502);
    expectErrorBody(response.body, { type: 'server_error', code: 'upstream_error' });
    expect(alias.sentTo(OPEN)).toHaveLength(1);
    expect((alias.sentTo(OPEN)[0] as Record<string, unknown>)['top_k']).toBe(40);
    expect(alias.sentTo(ANTHROPIC)).toEqual([]);
  });

  it('answers the same 502 upstream_error when the open-responses target is the only target of the alias', async () => {
    const alias = await startAlias([OPEN], {
      openScript: [openResponsesErrorReply(503, 'server_error', null, 'open target is down')],
      maxAttempts: 1,
    });
    const response = await alias.post('/v1/responses', { top_k: 40 });
    expect(response.status).toBe(502);
    expectErrorBody(response.body, { type: 'server_error', code: 'upstream_error' });
    expect(alias.sentTo(OPEN)).toHaveLength(1);
  });

  it('refuses with 400 unknown_parameter when no candidate passes unknown fields through', async () => {
    const alias = await startAlias([ANTHROPIC, OLLAMA]);
    const response = await alias.post('/v1/responses', { top_k: 40 });
    expectUnknownParameter(response, 'top_k', ['top_k']);
    expect(alias.sentTo(ANTHROPIC)).toEqual([]);
    expect(alias.sentTo(OLLAMA)).toEqual([]);
  });
});

describe('compact applies the same rule against CompactResponseMethodPublicBody', () => {
  it('carries top_k and x_future to the open-responses upstream and echoes neither', async () => {
    const alias = await startAlias([OPEN]);
    const response = await alias.post('/v1/responses/compact', UNKNOWN);
    expect(response.status).toBe(200);
    expect(response.body.output[0].type).toBe('compaction');
    const sent = alias.sentTo(OPEN);
    expect(sent).toHaveLength(1);
    expect((sent[0] as Record<string, unknown>)['top_k']).toBe(40);
    expect((sent[0] as Record<string, unknown>)['x_future']).toEqual({ a: 1 });
    expect(Object.keys(response.body)).not.toContain('top_k');
    expect(Object.keys(response.body)).not.toContain('x_future');
  });

  it.for([ANTHROPIC, CHAT_NATIVE, CHAT_CONSTRAINED, OLLAMA])('refuses top_k on %s with 400 unknown_parameter and sends nothing', async (target) => {
    const alias = await startAlias([target]);
    const response = await alias.post('/v1/responses/compact', { top_k: 40 });
    expectUnknownParameter(response, 'top_k', ['top_k']);
    expect(alias.sentTo(target)).toEqual([]);
  });

  it('treats a create-only field as unknown at compact: safety_identifier is refused on anthropic', async () => {
    const alias = await startAlias([ANTHROPIC]);
    const response = await alias.post('/v1/responses/compact', { safety_identifier: 'user-1' });
    expectUnknownParameter(response, 'safety_identifier', ['safety_identifier']);
    expect(alias.sentTo(ANTHROPIC)).toEqual([]);
  });

  it('carries a create-only field to the open-responses upstream at compact', async () => {
    const alias = await startAlias([OPEN]);
    const response = await alias.post('/v1/responses/compact', { safety_identifier: 'user-1' });
    expect(response.status).toBe(200);
    expect((alias.sentTo(OPEN)[0] as Record<string, unknown>)['safety_identifier']).toBe('user-1');
  });
});

describe('count_tokens stays strict whatever the target', () => {
  it('refuses top_k on an open-responses target with the same 400 and sends nothing', async () => {
    const alias = await startAlias([OPEN]);
    const response = await alias.post('/v1/momonga/count_tokens', { top_k: 40 });
    expectUnknownParameter(response, 'top_k', ['top_k']);
    expect(alias.sentTo(OPEN)).toEqual([]);
  });
});

describe('no known create field is taken for an unknown one', () => {
  const NON_NULL_VALUES: Record<string, unknown> = {
    model: 'fast',
    input: userInput('hi'),
    include: [],
    stream: false,
    background: false,
    truncation: 'disabled',
    store: false,
    service_tier: 'auto',
  };

  it('accepts a body carrying every CreateResponseBody property plus momonga.cache on a non-pass-through target', async () => {
    const properties = Object.keys(loadOpenResponsesSpec().components.schemas['CreateResponseBody']?.['properties'] as Record<string, unknown>);
    expect(properties.length).toBeGreaterThan(20);
    const body = Object.fromEntries(properties.map((name) => [name, name in NON_NULL_VALUES ? NON_NULL_VALUES[name] : null]));
    const alias = await startAlias([ANTHROPIC]);
    const response = await alias.post('/v1/responses', { ...body, momonga: { cache: { stable: 0, fixed: 0, previousHistory: 0, history: 1 } } });
    expect(response.body.error?.code).not.toBe('unknown_parameter');
    expect(response.status).toBe(200);
    expect(alias.sentTo(ANTHROPIC)).toHaveLength(1);
  });
});
