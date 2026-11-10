import { keyAuthSource } from '@momonga/gateway';
import { describe, expect, it } from 'vitest';
import { createAnthropicAdapter } from '@momonga/gateway';
import type { AnthropicApiVersion, Capabilities, ProviderAdapter } from '@momonga/protocol';
import { anthropicTextReply, createFakeClock, startFakeAnthropic } from '@momonga/testkit';
import type { FakeUpstreamServer } from '@momonga/testkit';
import { CC_CAPABILITIES, completionBodies, makeAdapter, startFake } from './cc-support.ts';
import { START_MS, postJson, readJson, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import { FAKE_API_KEY, REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';
import { UNDICI_DEFAULT_LIVENESS } from '@momonga/testkit';

const FIRST_ANTHROPIC = 'anthropic-first';
const SECOND_ANTHROPIC = 'anthropic-second';
const CHAT_FREE = 'chat-free';
const LEGACY_FREE = 'anthropic-legacy-free';

type Upstream = { adapter: ProviderAdapter; sent: () => unknown[] };

const anthropicUpstream = async (apiVersion: AnthropicApiVersion, capabilities: Capabilities): Promise<Upstream> => {
  const fake: FakeUpstreamServer = await startFakeAnthropic({ apiKey: FAKE_API_KEY, script: [anthropicTextReply(['from anthropic'])] });
  registerCleanup(() => fake.close());
  const adapter = createAnthropicAdapter({ liveness: UNDICI_DEFAULT_LIVENESS,
    resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
    authSource: keyAuthSource(async () => FAKE_API_KEY),
    capabilities: async () => capabilities,
    clock: createFakeClock(START_MS),
    apiVersion,
  });
  registerCleanup(() => adapter.close());
  return { adapter, sent: () => fake.requests.filter((request) => request.path === '/v1/messages').map((request) => request.body) };
};

const chatFreeUpstream = async (): Promise<Upstream> => {
  const fake = await startFake({ scenario: 'tools-ok' });
  const capabilities: Capabilities = Object.assign({}, CC_CAPABILITIES, { sampling: { accepts: 'free' } });
  return { adapter: makeAdapter(fake, { capabilities: async () => capabilities }), sent: () => completionBodies(fake) };
};

const upstreamFor = (name: string): Promise<Upstream> => {
  if (name === CHAT_FREE) return chatFreeUpstream();
  if (name === LEGACY_FREE) return anthropicUpstream('2023-06-01', Object.assign({}, REMOTE_CAPABILITIES, { sampling: { accepts: 'free' } }));
  return anthropicUpstream('2026-10-21', REMOTE_CAPABILITIES);
};

const startAlias = async (order: readonly string[]) => {
  const upstreams: Record<string, Upstream> = {};
  for (const name of order) upstreams[name] = await upstreamFor(name);
  const harness = await startGateway({
    adapters: Object.fromEntries(Object.entries(upstreams).map(([name, upstream]) => [name, upstream.adapter])),
    config: {
      aliases: { fast: [...order] },
      targets: Object.fromEntries(order.map((name) => [name, { model: 'upstream-model', kind: 'remote' as const }])),
    },
  });
  const post = async (body: Record<string, unknown>) => readJson(await postJson(harness.client, '/v1/responses', { model: 'fast', input: userInput('hi'), ...body }));
  return { post, sentTo: (name: string) => (upstreams[name] as Upstream).sent() };
};

describe('sampling acceptance narrows the candidates of a multi-target alias', () => {
  it('serves temperature from the chat-completions target when the anthropic target before it refuses it', async () => {
    const alias = await startAlias([FIRST_ANTHROPIC, CHAT_FREE]);
    const response = await alias.post({ temperature: 0.2 });
    expect(response.status).toBe(200);
    expect(alias.sentTo(FIRST_ANTHROPIC)).toEqual([]);
    expect(alias.sentTo(CHAT_FREE)).toHaveLength(1);
    expect((alias.sentTo(CHAT_FREE)[0] as Record<string, unknown>)['temperature']).toBe(0.2);
  });

  it('serves temperature from the chat-completions target when it comes first', async () => {
    const alias = await startAlias([CHAT_FREE, FIRST_ANTHROPIC]);
    const response = await alias.post({ temperature: 0.2 });
    expect(response.status).toBe(200);
    expect(alias.sentTo(CHAT_FREE)).toHaveLength(1);
    expect(alias.sentTo(FIRST_ANTHROPIC)).toEqual([]);
  });

  it('refuses with a named 400 only when every candidate refuses, naming the field and each refusing target', async () => {
    const alias = await startAlias([FIRST_ANTHROPIC, SECOND_ANTHROPIC]);
    const response = await alias.post({ temperature: 0.2 });
    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe('invalid_request');
    expect(response.body.error.param).toBe('temperature');
    expect(response.body.error.message).toContain('temperature');
    expect(response.body.error.message).toContain(FIRST_ANTHROPIC);
    expect(response.body.error.message).toContain(SECOND_ANTHROPIC);
    expect(alias.sentTo(FIRST_ANTHROPIC)).toEqual([]);
    expect(alias.sentTo(SECOND_ANTHROPIC)).toEqual([]);
  });

  it('serves temperature from a 2023-06-01 anthropic target declaring free ahead of a default-version anthropic target', async () => {
    const alias = await startAlias([LEGACY_FREE, FIRST_ANTHROPIC]);
    const response = await alias.post({ temperature: 0.2 });
    expect(response.status).toBe(200);
    expect(alias.sentTo(LEGACY_FREE)).toHaveLength(1);
    expect((alias.sentTo(LEGACY_FREE)[0] as Record<string, unknown>)['temperature']).toBe(0.2);
    expect(alias.sentTo(FIRST_ANTHROPIC)).toEqual([]);
  });

  it('serves temperature from the 2023-06-01 anthropic target when the default-version target comes first, sending nothing to it', async () => {
    const alias = await startAlias([FIRST_ANTHROPIC, LEGACY_FREE]);
    const response = await alias.post({ temperature: 0.2 });
    expect(response.status).toBe(200);
    expect(alias.sentTo(FIRST_ANTHROPIC)).toEqual([]);
    expect(alias.sentTo(LEGACY_FREE)).toHaveLength(1);
    expect((alias.sentTo(LEGACY_FREE)[0] as Record<string, unknown>)['temperature']).toBe(0.2);
  });

  it('keeps the alias order for a request that carries no sampling field', async () => {
    const alias = await startAlias([FIRST_ANTHROPIC, CHAT_FREE]);
    const response = await alias.post({});
    expect(response.status).toBe(200);
    expect(alias.sentTo(FIRST_ANTHROPIC)).toHaveLength(1);
    expect(alias.sentTo(CHAT_FREE)).toEqual([]);
  });
});
