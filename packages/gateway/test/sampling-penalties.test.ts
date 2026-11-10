import { describe, expect, it } from 'vitest';
import type { AdapterRequest, Capabilities, SamplingCapability } from '@momonga/protocol';
import { openResponsesTextReply } from '@momonga/testkit';
import { CC_CAPABILITIES, collect, completionBodies, makeAdapter, startFake, terminalOf } from './cc-support.ts';
import { postJson, readJson, readSse, startGateway, userInput } from './gateway-helpers.ts';
import { chunkLine, collectOllama, doneLine, makeOllamaAdapter, OLLAMA_CAPABILITIES, startFakeOllama } from './ollama-support.ts';
import { REMOTE_CAPABILITIES, startOpenResponsesGateway } from './upstream-gateway-support.ts';

const PENALTIES = { frequency_penalty: 0.3, presence_penalty: 0.4 } as const;
const EVERY_SAMPLING_FIELD = { temperature: 0.2, top_p: 0.9, ...PENALTIES } as const;

const singleTarget = { chains: { 'scripted/upstream-model': ['scripted/upstream-model'] }, targets: { 'scripted/upstream-model': { kind: 'remote' } } };

const withSampling = (capabilities: Capabilities, sampling: SamplingCapability | undefined, extra: Record<string, unknown> = {}): Capabilities =>
  Object.assign({}, capabilities, extra, sampling === undefined ? {} : { sampling });

const startChatCompletionsGateway = async (capabilities: Capabilities) => {
  const fake = await startFake({ scenario: 'tools-ok' });
  const adapter = makeAdapter(fake, { capabilities: async () => capabilities });
  const harness = await startGateway({ adapters: { 'scripted/upstream-model': adapter }, config: singleTarget });
  return { ...harness, fake };
};

describe('the penalties reach the adapters that render them', () => {
  it('a chat-completions target with nothing declared forwards both penalties', async () => {
    const gateway = await startChatCompletionsGateway(CC_CAPABILITIES);
    const response = await readJson(await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', input: userInput('hi'), ...PENALTIES }));
    expect(response.status).toBe(200);
    const [body] = completionBodies(gateway.fake);
    expect(body.frequency_penalty).toBe(0.3);
    expect(body.presence_penalty).toBe(0.4);
  });

  it('an open-responses target with nothing declared forwards both penalties', async () => {
    const gateway = await startOpenResponsesGateway({ script: [openResponsesTextReply(['ok'])] });
    const response = await readJson(await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', input: userInput('hi'), ...PENALTIES }));
    expect(response.status).toBe(200);
    const body = gateway.fake.requests[0]?.body as Record<string, unknown> | undefined;
    expect(body?.['frequency_penalty']).toBe(0.3);
    expect(body?.['presence_penalty']).toBe(0.4);
  });

  it('an ollama target renders both penalties in options', async () => {
    const fake = await startFakeOllama({ chat: [{ kind: 'ndjson', lines: [chunkLine({ content: 'ok' }), doneLine()] }] });
    const adapter = makeOllamaAdapter(fake, { capabilities: async () => OLLAMA_CAPABILITIES });
    const request = Object.assign({ model: 'devstral-small-2', input: [{ type: 'message' as const, role: 'user' as const, content: 'hi' }] }, PENALTIES) as AdapterRequest;
    const { error } = await collectOllama(adapter, request);
    expect(error).toBeUndefined();
    expect(fake.chatBodies()[0].options).toMatchObject({ frequency_penalty: 0.3, presence_penalty: 0.4 });
  });
});

describe('the penalties go through the same acceptance check', () => {
  it.for(['frequency_penalty', 'presence_penalty'] as const)('a chat-completions target that declares none refuses %s, naming it and the target', async (param) => {
    const gateway = await startChatCompletionsGateway(withSampling(CC_CAPABILITIES, { accepts: 'none' }));
    const response = await readJson(await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', input: userInput('hi'), [param]: PENALTIES[param] }));
    expect(response.status).toBe(400);
    expect(response.body.error.param).toBe(param);
    expect(response.body.error.message).toContain(param);
    expect(response.body.error.message).toContain('upstream-model');
    expect(completionBodies(gateway.fake)).toEqual([]);
  });

  it('an open-responses target that declares none refuses temperature, naming it and the target', async () => {
    const gateway = await startOpenResponsesGateway({ script: [openResponsesTextReply(['ok'])], capabilities: withSampling(REMOTE_CAPABILITIES, { accepts: 'none' }) });
    const response = await readJson(await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', input: userInput('hi'), temperature: 0.2 }));
    expect(response.status).toBe(400);
    expect(response.body.error.param).toBe('temperature');
    expect(response.body.error.message).toContain('upstream-model');
    expect(gateway.fake.requests).toEqual([]);
  });
});

describe('thinking on through the reasoning_effort control', () => {
  it('a chat-completions target under without_thinking refuses temperature when effort high resolves to a level other than none', async () => {
    const capabilities = withSampling(CC_CAPABILITIES, { accepts: 'without_thinking', topP: { min: 0.95, max: 1 } }, { reasoning: { control: 'reasoning_effort', lowest: 'none' } });
    const gateway = await startChatCompletionsGateway(capabilities);
    const response = await readJson(
      await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', input: userInput('hi'), reasoning: { effort: 'high' }, temperature: 0.2 }),
    );
    expect(response.status).toBe(400);
    expect(response.body.error.param).toBe('temperature');
    expect(response.body.error.message).toContain('upstream-model');
    expect(completionBodies(gateway.fake)).toEqual([]);
  });
});

describe('thinking off through the reasoning_effort control', () => {
  it('a chat-completions target under without_thinking forwards temperature when effort none resolves to none', async () => {
    const capabilities = withSampling(CC_CAPABILITIES, { accepts: 'without_thinking', topP: { min: 0.95, max: 1 } }, { reasoning: { control: 'reasoning_effort', lowest: 'none' } });
    const gateway = await startChatCompletionsGateway(capabilities);
    const response = await readJson(
      await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', input: userInput('hi'), reasoning: { effort: 'none' }, temperature: 0.2 }),
    );
    expect(response.status).toBe(200);
    const [body] = completionBodies(gateway.fake);
    expect(body.temperature).toBe(0.2);
  });
});

describe('the response echoes every sampling field the request carried', () => {
  it('the non-streamed resource and the streamed terminal resource both echo the request values', async () => {
    const gateway = await startChatCompletionsGateway(CC_CAPABILITIES);
    const unary = await readJson(await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', input: userInput('hi'), ...EVERY_SAMPLING_FIELD }));
    const frames = await readSse(await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', stream: true, input: userInput('hi'), ...EVERY_SAMPLING_FIELD }));
    const streamed = frames.at(-1)?.data.response;
    expect(unary.status).toBe(200);
    expect(unary.body).toMatchObject(EVERY_SAMPLING_FIELD);
    expect(streamed).toMatchObject(EVERY_SAMPLING_FIELD);
  });

  it('the adapter response emitter echoes the same values as the gateway resource', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const adapter = makeAdapter(fake);
    const request = Object.assign({ model: 'system', input: [{ type: 'message' as const, role: 'user' as const, content: 'hi' }] }, EVERY_SAMPLING_FIELD) as AdapterRequest;
    const { events, error } = await collect(adapter, request);
    expect(error).toBeUndefined();
    expect(terminalOf(events).response).toMatchObject(EVERY_SAMPLING_FIELD);
  });
});
