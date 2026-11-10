import { EVERY_REASONING_IS_OWN } from './own-reasoning.ts';
import { describe, expect, it } from 'vitest';
import { anthropicTextReply } from '@momonga/testkit';
import type { AdapterInputItem, AdapterRequest, Capabilities, PromptCacheCounts } from '@momonga/protocol';
import { buildCountTokensBody, buildMessagesBody } from '../src/adapters/anthropic/request.ts';
import { postJson, readJson } from './gateway-helpers.ts';
import { REMOTE_CAPABILITIES, startAnthropicGateway } from './upstream-gateway-support.ts';

const MAX_TOKENS = 4096;

const CACHING: Capabilities = { ...REMOTE_CAPABILITIES, promptCache: { kind: 'breakpoints', maxBreakpoints: 4 } };

const say = (role: 'system' | 'developer' | 'user' | 'assistant', text: string): AdapterInputItem => ({ type: 'message', role, content: text });

const tool = { type: 'function', name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } } as const;

const CONVERSATION: AdapterInputItem[] = [say('system', 'rules'), say('user', 'one'), say('assistant', 'two'), say('user', 'three'), say('assistant', 'four'), say('user', 'five')];

const MARKS: PromptCacheCounts = { stable: 1, fixed: 1, previousHistory: 4, history: 6 };

type Block = { text?: string; name?: string; cache_control?: unknown };

type WireBody = { system?: readonly Block[] | undefined; messages: ReadonlyArray<{ content: unknown }>; tools?: readonly Block[] | undefined };

const cachedTextsOf = (body: WireBody): string[] => {
  const blocks: Block[] = [...(body.tools ?? []), ...(body.system ?? []), ...body.messages.flatMap((message) => message.content as Block[])];
  return blocks.filter((block) => block.cache_control !== undefined).map((block) => block.text ?? `tool:${block.name}`);
};

const bodyWith = (request: AdapterRequest, maxBreakpoints: number, marks: PromptCacheCounts) =>
  buildMessagesBody(request, MAX_TOKENS, { cache: { maxBreakpoints, marks } }, EVERY_REASONING_IS_OWN);

describe('Anthropic breakpoints follow the marks the client sends', () => {
  it('places a breakpoint on the last wire block before each mark, and nowhere else', () => {
    const body = bodyWith({ model: 'm', input: CONVERSATION, tools: [tool] }, 4, MARKS);
    expect(cachedTextsOf(body).sort()).toEqual(['five', 'rules', 'three']);
  });

  it('marks every breakpoint as ephemeral', () => {
    const body = bodyWith({ model: 'm', input: CONVERSATION, tools: [tool] }, 4, MARKS);
    expect(body.system?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('keeps history first when the target allows one breakpoint', () => {
    const body = bodyWith({ model: 'm', input: CONVERSATION, tools: [tool] }, 1, MARKS);
    expect(cachedTextsOf(body)).toEqual(['five']);
  });

  it('takes history, then stable, when the target allows two breakpoints', () => {
    const body = bodyWith({ model: 'm', input: CONVERSATION, tools: [tool] }, 2, MARKS);
    expect(cachedTextsOf(body).sort()).toEqual(['five', 'rules']);
  });

  it('takes history, stable, fixed, then previousHistory, each on its own block, when all four differ', () => {
    const input = [say('system', 'rules'), say('system', 'memory'), ...CONVERSATION.slice(1)];
    const marks = { stable: 1, fixed: 2, previousHistory: 5, history: 7 };
    expect(cachedTextsOf(bodyWith({ model: 'm', input }, 3, marks)).sort()).toEqual(['five', 'memory', 'rules']);
    expect(cachedTextsOf(bodyWith({ model: 'm', input }, 4, marks)).sort()).toEqual(['five', 'memory', 'rules', 'three']);
  });

  it('maps a mark to the system block of a hoisted item, and past a hoisted item to the message block that precedes it in the wire', () => {
    const input = [say('system', 'rules'), say('user', 'task'), say('developer', 'nested'), say('user', 'more')];
    const body = bodyWith({ model: 'm', input, instructions: 'first' }, 4, { stable: 1, fixed: 3, history: 4 });
    expect(body.system?.map((block) => block.text)).toEqual(['first', 'rules', 'nested']);
    expect(cachedTextsOf(body).sort()).toEqual(['more', 'rules', 'task']);
  });

  it('places no breakpoint for a mark that no input item precedes', () => {
    const input = [say('user', 'one'), say('assistant', 'two')];
    const body = bodyWith({ model: 'm', input, tools: [tool], instructions: 'first' }, 4, { stable: 0, fixed: 0, history: 2 });
    expect(cachedTextsOf(body)).toEqual(['two']);
  });

  it('places a single breakpoint when every mark falls on the same block', () => {
    const body = bodyWith({ model: 'm', input: CONVERSATION }, 4, { stable: 6, fixed: 6, previousHistory: 6, history: 6 });
    expect(cachedTextsOf(body)).toEqual(['five']);
  });

  it('keeps the inferred placement when no marks are given', () => {
    const withMarks = buildMessagesBody({ model: 'm', input: CONVERSATION, tools: [tool] }, MAX_TOKENS, { cache: { maxBreakpoints: 4 } }, EVERY_REASONING_IS_OWN);
    expect(cachedTextsOf(withMarks).sort()).toEqual(['five', 'rules', 'tool:read_file']);
  });

  it('puts no breakpoint into a body rendered for counting, marks or not', () => {
    const body = buildCountTokensBody({ model: 'm', input: CONVERSATION, tools: [tool], cacheMarks: MARKS }, EVERY_REASONING_IS_OWN);
    expect(cachedTextsOf(body)).toEqual([]);
  });
});

describe('the Anthropic adapter applies the marks of a gateway request per its target capability', () => {
  const input = [
    { type: 'message', role: 'system', content: 'rules' },
    { type: 'message', role: 'user', content: 'one' },
    { type: 'message', role: 'assistant', content: 'two' },
    { type: 'message', role: 'user', content: 'three' },
    { type: 'message', role: 'assistant', content: 'four' },
    { type: 'message', role: 'user', content: 'five' },
  ];

  it('places the breakpoints at the marks when the target declares breakpoints', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicTextReply(['ok'])], capabilities: CACHING });
    const response = await readJson(await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', input, momonga: { cache: MARKS } }));
    expect(response.status).toBe(200);
    expect(cachedTextsOf(gateway.fake.requests[0]?.body as never).sort()).toEqual(['five', 'rules', 'three']);
  });

  it('sends no breakpoint for marks when the target has no promptCache capability', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicTextReply(['ok'])], capabilities: REMOTE_CAPABILITIES });
    const response = await readJson(await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', input, momonga: { cache: MARKS } }));
    expect(response.status).toBe(200);
    expect(cachedTextsOf(gateway.fake.requests[0]?.body as never)).toEqual([]);
  });

  it('never forwards momonga or a prompt_cache_key to the Anthropic wire', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicTextReply(['ok'])], capabilities: CACHING });
    await readJson(await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', input, prompt_cache_key: 'k', momonga: { cache: MARKS } }));
    const sent = gateway.fake.requests[0]?.body as Record<string, unknown>;
    expect(sent).not.toHaveProperty('momonga');
    expect(sent).not.toHaveProperty('prompt_cache_key');
    expect(cachedTextsOf(sent as never).sort()).toEqual(['five', 'rules', 'three']);
  });
});
