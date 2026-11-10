import { keyAuthSource } from '@momonga/gateway';
import { describe, expect, it } from 'vitest';
import { createAnthropicAdapter } from '@momonga/gateway';
import type { AdapterCompactRequest, Capabilities, ReasoningCapability, ReasoningEffort } from '@momonga/protocol';
import {
  anthropicBlockDelta,
  anthropicBlockStart,
  anthropicBlockStop,
  anthropicMessageEnd,
  anthropicMessageStart,
  anthropicStream,
  anthropicTextReply,
  anthropicToolUseBlock,
  createFakeClock,
  startFakeAnthropic,
} from '@momonga/testkit';
import { contextOf } from './own-reasoning.ts';
import { START_MS, postJson, readSse, registerCleanup, userInput } from './gateway-helpers.ts';
import { FAKE_API_KEY, REMOTE_CAPABILITIES, readFileTool, startAnthropicGateway, streamResponse, terminalOf } from './upstream-gateway-support.ts';
import { UNDICI_DEFAULT_LIVENESS } from '@momonga/testkit';

const ADAPTIVE: ReasoningCapability = { control: 'thinking', form: 'adaptive', efforts: ['low', 'medium', 'high'] };
const BUDGET: ReasoningCapability = { control: 'thinking', form: 'budget', budgets: { low: 2048, medium: 4096, high: 6000 } };
const GAPPED_BUDGET: ReasoningCapability = { control: 'thinking', form: 'budget', budgets: { low: 2048, high: 6000 } };

const withReasoning = (reasoning: ReasoningCapability): Capabilities => ({ ...REMOTE_CAPABILITIES, reasoning });

const sentBodies = (gateway: Awaited<ReturnType<typeof startAnthropicGateway>>): any[] =>
  gateway.fake.requests.filter((request) => request.path === '/v1/messages').map((request) => request.body);

const sentFor = async (reasoning: ReasoningCapability | undefined, effort: ReasoningEffort, extra: Record<string, unknown> = {}): Promise<any> => {
  const gateway = await startAnthropicGateway({
    script: [anthropicTextReply(['ok'])],
    ...(reasoning === undefined ? {} : { capabilities: withReasoning(reasoning) }),
  });
  await streamResponse(gateway, { reasoning: { effort, summary: null }, ...extra });
  return sentBodies(gateway).at(-1);
};

const VISIBLE = 1000;

const REMOTE_TARGET = { name: 'remote', display: 'remote', model: 'remote-model' };

const directAdapter = async (reasoning: ReasoningCapability, reply: ReturnType<typeof anthropicTextReply>) => {
  const fake = await startFakeAnthropic({ apiKey: FAKE_API_KEY, script: [reply] });
  registerCleanup(() => fake.close());
  const adapter = createAnthropicAdapter({ liveness: UNDICI_DEFAULT_LIVENESS,
    resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
    authSource: keyAuthSource(async () => FAKE_API_KEY),
    capabilities: async () => withReasoning(reasoning),
    clock: createFakeClock(START_MS),
    apiVersion: '2026-10-21',
  });
  registerCleanup(() => adapter.close());
  return { fake, adapter };
};

const directBodyFor = async (reasoning: ReasoningCapability, effort: ReasoningEffort): Promise<any> => {
  const { fake, adapter } = await directAdapter(reasoning, anthropicTextReply(['ok']));
  const request = { model: 'remote-model', input: [{ type: 'message' as const, role: 'user' as const, content: 'hello' }], max_output_tokens: VISIBLE, reasoning_effort: effort };
  for await (const _event of adapter.create(request, await contextOf(adapter, REMOTE_TARGET))) {
    continue;
  }
  return fake.requests.filter((request) => request.path === '/v1/messages').at(-1)?.body;
};

describe('anthropic thinking request from a declared adaptive form', () => {
  it.for(['low', 'medium', 'high'] as const)('sends adaptive thinking with output_config.effort %s', async (effort) => {
    const body = await sentFor(ADAPTIVE, effort);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort });
  });

  it('sends a level above the declared ones as the highest declared level, never as max', async () => {
    const body = await sentFor(ADAPTIVE, 'xhigh');
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'high' });
    expect(JSON.stringify(body)).not.toContain('"max"');
  });

  it('clamps the internal level minimal up to the lowest declared adaptive level', async () => {
    const body = await directBodyFor(ADAPTIVE, 'minimal');
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'low' });
  });

  it('lifts none to the lowest declared level when the target declares no way to turn thinking off', async () => {
    const body = await sentFor(ADAPTIVE, 'none');
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'low' });
  });

  it.for(['disabled', 'between_tools'] as const)('sends none as thinking type %s when the target declares that off spelling', async (off) => {
    const body = await sentFor({ ...ADAPTIVE, off }, 'none');
    expect(body.thinking).toEqual({ type: off });
  });

  it('sends no thinking when the request asks for no effort', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicTextReply(['ok'])], capabilities: withReasoning(ADAPTIVE) });
    await streamResponse(gateway);
    const body = sentBodies(gateway).at(-1);
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });
});

describe('anthropic thinking request from a declared budget form', () => {
  it.for([
    ['low', 2048],
    ['medium', 4096],
    ['high', 6000],
  ] as const)('sends enabled thinking with the budget declared for %s and adds it to the visible cap', async ([effort, budget]) => {
    const body = await sentFor(BUDGET, effort, { max_output_tokens: VISIBLE });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: budget });
    expect(body.max_tokens).toBe(VISIBLE + budget);
    expect(body.output_config).toBeUndefined();
  });

  it('sends the budget of the nearest declared level below a level with no budget', async () => {
    const body = await sentFor(GAPPED_BUDGET, 'medium', { max_output_tokens: VISIBLE });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });

  it('sends the budget of the highest declared level for a level above it', async () => {
    const body = await sentFor(GAPPED_BUDGET, 'xhigh', { max_output_tokens: VISIBLE });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 6000 });
  });

  it('clamps the internal level minimal up to the lowest declared budget', async () => {
    const body = await directBodyFor(BUDGET, 'minimal');
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });

  it('lifts none to the lowest declared budget when the target declares no way to turn thinking off', async () => {
    const body = await sentFor(BUDGET, 'none', { max_output_tokens: VISIBLE });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });

  it('sends none as disabled thinking with no budget when the target declares that off spelling', async () => {
    const body = await sentFor({ ...BUDGET, off: 'disabled' }, 'none', { max_output_tokens: VISIBLE });
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.max_tokens).toBe(VISIBLE);
  });

  it('sends the declared budget under the model maximum when the request asks for no visible cap', async () => {
    const body = await sentFor(BUDGET, 'high');
    expect(body.max_tokens).toBe(REMOTE_CAPABILITIES.maxOutputTokens);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 6000 });
  });

  it('keeps the budget at 1024 when the requested cap is within 1024 of the model maximum', async () => {
    const body = await sentFor(BUDGET, 'low', { max_output_tokens: REMOTE_CAPABILITIES.maxOutputTokens - 500 });
    expect(body.max_tokens).toBe(REMOTE_CAPABILITIES.maxOutputTokens);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  });

  it('rejects minimal in a public request, since the Open Responses effort enum has no minimal', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicTextReply(['ok'])], capabilities: withReasoning(BUDGET) });
    const response = await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', input: userInput('hi'), reasoning: { effort: 'minimal' } });
    expect(response.status).toBe(400);
    expect(sentBodies(gateway)).toEqual([]);
  });

  it('shrinks the budget when the model output maximum binds, keeping it below max_tokens', async () => {
    const body = await sentFor(BUDGET, 'high', { max_output_tokens: 3000 });
    expect(body.max_tokens).toBe(REMOTE_CAPABILITIES.maxOutputTokens);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: REMOTE_CAPABILITIES.maxOutputTokens - 3000 });
    expect(body.thinking.budget_tokens).toBeLessThan(body.max_tokens);
  });

  it('adds the lowest budget to the compaction summary cap, and the summary still arrives', async () => {
    const { fake, adapter } = await directAdapter(BUDGET, anthropicTextReply(['GOAL: fix it. STATE: none.']));
    const compactRequest: AdapterCompactRequest = { model: 'remote-model', input: [{ type: 'message', role: 'user', content: 'a long conversation' }], momonga: { max_summary_tokens: 64 } };
    const result = await adapter.compact?.(compactRequest, await contextOf(adapter, REMOTE_TARGET));
    expect(result?.summary).toBe('GOAL: fix it. STATE: none.');
    const body: any = fake.requests.filter((request) => request.path === '/v1/messages').at(-1)?.body;
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(body.max_tokens).toBe(64 + 2048);
  });
});

describe('anthropic target with no declared thinking form', () => {
  it('sends neither thinking nor output_config', async () => {
    const body = await sentFor(undefined, 'high');
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });
});

const SIGNATURE = 'opaque-signature-of-the-thinking-block';
const THINKING = 'Plan: read a.txt first.';

const thinkingThenToolUse = () =>
  anthropicStream([
    anthropicMessageStart(),
    anthropicBlockStart(0, { type: 'thinking', thinking: '' }),
    anthropicBlockDelta(0, { type: 'thinking_delta', thinking: THINKING }),
    anthropicBlockDelta(0, { type: 'signature_delta', signature: SIGNATURE }),
    anthropicBlockStop(0),
    ...anthropicToolUseBlock(1, 'toolu_01', 'read_file', ['{"path":"a.txt"}']),
    ...anthropicMessageEnd('tool_use'),
  ]);

describe('thinking in a tool loop on a target that declares the adaptive form', () => {
  it('asks for thinking on both turns and sends the signed thinking block back before the tool use', async () => {
    const gateway = await startAnthropicGateway({ script: [thinkingThenToolUse(), anthropicTextReply(['done'])], capabilities: withReasoning(ADAPTIVE) });
    const first = await streamResponse(gateway, { tools: [readFileTool], input: userInput('read a.txt'), reasoning: { effort: 'medium', summary: null } });
    const output: any[] = terminalOf(first).response.output;
    expect(output.map((item) => item.type)).toEqual(['reasoning', 'function_call']);
    const callId: string = output[1].call_id;

    await readSse(
      await postJson(gateway.client, '/v1/responses', {
        model: 'scripted/upstream-model',
        stream: true,
        tools: [readFileTool],
        reasoning: { effort: 'medium', summary: null },
        input: [...userInput('read a.txt'), ...output, { type: 'function_call_output', call_id: callId, output: 'alpha' }],
      }),
    );

    const [firstBody, secondBody] = sentBodies(gateway);
    expect(firstBody.thinking).toEqual({ type: 'adaptive' });
    expect(secondBody.thinking).toEqual({ type: 'adaptive' });
    const assistant = secondBody.messages.find((message: any) => message.role === 'assistant');
    expect(assistant.content).toEqual([
      { type: 'thinking', thinking: THINKING, signature: SIGNATURE },
      { type: 'tool_use', id: callId, name: 'read_file', input: { path: 'a.txt' } },
    ]);
  });
});
