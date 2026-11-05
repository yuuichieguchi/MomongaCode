import { EVERY_REASONING_IS_OWN } from './own-reasoning.ts';
import { describe, expect, it } from 'vitest';
import { anthropicCountTokensReply, anthropicTextReply } from '@momonga/testkit';
import type { AdapterInputItem, Capabilities } from '@momonga/protocol';
import { buildMessagesBody } from '../src/adapters/anthropic/request.ts';
import { postJson, readJson, userInput } from './gateway-helpers.ts';
import { REMOTE_CAPABILITIES, readFileTool, startAnthropicGateway, streamResponse } from './upstream-gateway-support.ts';

const MAX_TOKENS = 4096;

const CACHING: Capabilities = { ...REMOTE_CAPABILITIES, promptCache: { kind: 'breakpoints', maxBreakpoints: 4 } };

const user = (text: string): AdapterInputItem => ({ type: 'message', role: 'user', content: text });
const assistant = (text: string): AdapterInputItem => ({ type: 'message', role: 'assistant', content: text });
const summary: AdapterInputItem = { type: 'compaction_summary', summary: 'earlier' };
const system: AdapterInputItem = { type: 'message', role: 'system', content: 'rules' };
const tool = { type: 'function', name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } } as const;

const FOUR_PLACES = { model: 'm', input: [system, summary, user('one'), assistant('two'), user('three')], instructions: 'first', tools: [tool] };

const breakpointsIn = (value: unknown): number => JSON.stringify(value).split('"cache_control"').length - 1;

describe('the Anthropic body follows the cache plan it is given', () => {
  it('sends no breakpoint without a plan', () => {
    expect(breakpointsIn(buildMessagesBody(FOUR_PLACES, MAX_TOKENS, { cache: undefined }, EVERY_REASONING_IS_OWN))).toBe(0);
  });

  it('sends breakpoints, at most the declared maximum, with a plan', () => {
    const count = breakpointsIn(buildMessagesBody(FOUR_PLACES, MAX_TOKENS, { cache: { maxBreakpoints: 4 } }, EVERY_REASONING_IS_OWN));
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(4);
  });

  it('never sends more breakpoints than the plan allows', () => {
    expect(breakpointsIn(buildMessagesBody(FOUR_PLACES, MAX_TOKENS, { cache: { maxBreakpoints: 1 } }, EVERY_REASONING_IS_OWN))).toBeLessThanOrEqual(1);
  });
});

describe('the Anthropic adapter follows the promptCache capability of the answering target', () => {
  it('sends no cache_control when the capability is absent, because absent means unknown', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicTextReply(['ok'])], capabilities: REMOTE_CAPABILITIES });
    await streamResponse(gateway, { instructions: 'be brief', tools: [readFileTool] });
    expect(gateway.fake.requests).toHaveLength(1);
    expect(breakpointsIn(gateway.fake.requests[0]?.body)).toBe(0);
  });

  it('sends breakpoints, at most four, when the target declares four', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicTextReply(['ok'])], capabilities: CACHING });
    await streamResponse(gateway, { instructions: 'be brief', tools: [readFileTool] });
    const count = breakpointsIn(gateway.fake.requests[0]?.body);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(4);
  });

  it('sends no breakpoint on a compaction summary request or on the count that sizes it, even when the target declares breakpoints', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicCountTokensReply(80), anthropicTextReply(['summary'])], capabilities: CACHING });
    const response = await readJson(
      await postJson(gateway.client, '/v1/responses/compact', {
        model: 'fast',
        input: [...userInput('do X'), { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }, { type: 'function_call_output', call_id: 'c1', output: 'body' }],
      }),
    );
    expect(response.status).toBe(200);
    expect(gateway.fake.requests.map((request) => request.path)).toEqual(['/v1/messages/count_tokens', '/v1/messages']);
    for (const request of gateway.fake.requests) expect(breakpointsIn(request.body)).toBe(0);
  });

  it('sends no breakpoint on a count, even when the target declares breakpoints', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicCountTokensReply(321)], capabilities: CACHING });
    const response = await readJson(
      await postJson(gateway.client, '/v1/momonga/count_tokens', { model: 'fast', instructions: 'be brief', input: userInput('hello'), tools: [readFileTool] }),
    );
    expect(response.status).toBe(200);
    expect(breakpointsIn(gateway.fake.requests[0]?.body)).toBe(0);
  });
});
