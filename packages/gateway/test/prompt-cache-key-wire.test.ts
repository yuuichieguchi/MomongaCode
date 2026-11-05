import { describe, expect, it } from 'vitest';
import { openResponsesTextReply } from '@momonga/testkit';
import type { AdapterRequest, Capabilities, PromptCacheCapability, PromptCacheCounts } from '@momonga/protocol';
import { CC_CAPABILITIES, collect, lastCompletionBody, makeAdapter, startFake, userText } from './cc-support.ts';
import { postJson, readJson } from './gateway-helpers.ts';
import { OLLAMA_CAPABILITIES, chunkLine, collectOllama, doneLine, makeOllamaAdapter, startFakeOllama } from './ollama-support.ts';
import { REMOTE_CAPABILITIES, startOpenResponsesGateway } from './upstream-gateway-support.ts';

const KEY = 'stable-prefix-key-0001';

const MARKS: PromptCacheCounts = { stable: 1, fixed: 1, history: 2 };

const CACHE_KINDS: Array<{ name: string; promptCache: PromptCacheCapability | undefined }> = [
  { name: 'key', promptCache: { kind: 'key' } },
  { name: 'automatic', promptCache: { kind: 'automatic' } },
  { name: 'none', promptCache: { kind: 'none' } },
  { name: 'breakpoints', promptCache: { kind: 'breakpoints', maxBreakpoints: 4 } },
  { name: 'absent', promptCache: undefined },
];

const withCache = (base: Capabilities, promptCache: PromptCacheCapability | undefined): Capabilities => {
  const { promptCache: _dropped, ...rest } = base;
  return promptCache === undefined ? rest : { ...rest, promptCache };
};

const request = (extra: Partial<AdapterRequest> = {}): AdapterRequest => ({
  model: 'system',
  input: [{ type: 'message', role: 'system', content: 'rules' }, userText('hi')],
  ...extra,
});

const chatCompletionsBody = async (promptCache: PromptCacheCapability | undefined, toolCalling: 'native' | 'constrained'): Promise<Record<string, unknown>> => {
  const fake = await startFake({ scenario: 'tools-ok' });
  const adapter = makeAdapter(fake, { capabilities: async () => withCache({ ...CC_CAPABILITIES, toolCalling }, promptCache) });
  const { error } = await collect(adapter, request({ promptCacheKey: KEY, cacheMarks: MARKS }));
  expect(error).toBeUndefined();
  return lastCompletionBody(fake);
};

describe('chat-completions sends prompt_cache_key only to a target whose capability is key', () => {
  it.for(['native', 'constrained'] as const)('sends the request key as prompt_cache_key on the %s path', async (toolCalling) => {
    const body = await chatCompletionsBody({ kind: 'key' }, toolCalling);
    expect(body['prompt_cache_key']).toBe(KEY);
  });

  it.for(CACHE_KINDS.filter((entry) => entry.name !== 'key'))('sends no prompt_cache_key when the capability is $name', async ({ promptCache }) => {
    for (const toolCalling of ['native', 'constrained'] as const) {
      const body = await chatCompletionsBody(promptCache, toolCalling);
      expect(body).not.toHaveProperty('prompt_cache_key');
    }
  });

  it('never forwards the marks', async () => {
    for (const toolCalling of ['native', 'constrained'] as const) {
      const body = await chatCompletionsBody({ kind: 'key' }, toolCalling);
      expect(body).not.toHaveProperty('momonga');
      expect(JSON.stringify(body)).not.toContain('previousHistory');
    }
  });

  it('sends no prompt_cache_key for a key target when the request carries none', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const adapter = makeAdapter(fake, { capabilities: async () => withCache(CC_CAPABILITIES, { kind: 'key' }) });
    const { error } = await collect(adapter, request());
    expect(error).toBeUndefined();
    expect(lastCompletionBody(fake)).not.toHaveProperty('prompt_cache_key');
  });
});

describe('the open-responses relay sends prompt_cache_key only for key and never forwards momonga', () => {
  const input = [
    { type: 'message', role: 'system', content: 'rules' },
    { type: 'message', role: 'user', content: 'hi' },
  ];

  const relayed = async (promptCache: PromptCacheCapability | undefined): Promise<Record<string, unknown>> => {
    const gateway = await startOpenResponsesGateway({ script: [openResponsesTextReply(['ok'])], capabilities: withCache(REMOTE_CAPABILITIES, promptCache) });
    const response = await readJson(await postJson(gateway.client, '/v1/responses', { model: 'fast', input, prompt_cache_key: KEY, momonga: { cache: MARKS } }));
    expect(response.status).toBe(200);
    expect(gateway.fake.requests).toHaveLength(1);
    return gateway.fake.requests[0]?.body as Record<string, unknown>;
  };

  it('relays the key to a key target, without momonga', async () => {
    const body = await relayed({ kind: 'key' });
    expect(body['prompt_cache_key']).toBe(KEY);
    expect(body).not.toHaveProperty('momonga');
  });

  it.for(CACHE_KINDS.filter((entry) => entry.name !== 'key'))('relays neither key nor momonga when the capability is $name', async ({ promptCache }) => {
    const body = await relayed(promptCache);
    expect(body).not.toHaveProperty('prompt_cache_key');
    expect(body).not.toHaveProperty('momonga');
  });
});

describe('the ollama adapter applies no cache control: its native chat API has neither a key nor breakpoints', () => {
  const textReply = () => ({ kind: 'ndjson' as const, lines: [chunkLine({ content: 'ok' }), doneLine()] });

  const ollamaBody = async (promptCache: PromptCacheCapability | undefined, extra: Partial<AdapterRequest>): Promise<unknown> => {
    const fake = await startFakeOllama({ chat: [textReply()] });
    const adapter = makeOllamaAdapter(fake, { capabilities: async () => withCache(OLLAMA_CAPABILITIES, promptCache) });
    const { error } = await collectOllama(adapter, request({ model: 'devstral-small-2', ...extra }));
    expect(error).toBeUndefined();
    return fake.chatBodies()[0];
  };

  it.for(CACHE_KINDS)('sends the same body with or without key and marks when the capability is $name', async ({ promptCache }) => {
    const plain = await ollamaBody(promptCache, {});
    const marked = await ollamaBody(promptCache, { promptCacheKey: KEY, cacheMarks: MARKS });
    expect(marked).toEqual(plain);
    expect(JSON.stringify(marked)).not.toContain(KEY);
  });
});
