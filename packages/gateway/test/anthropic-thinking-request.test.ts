import { describe, expect, it } from 'vitest';
import type { Capabilities, ReasoningCapability, ReasoningEffort } from '@momonga/protocol';
import {
  anthropicBlockDelta,
  anthropicBlockStart,
  anthropicBlockStop,
  anthropicMessageEnd,
  anthropicMessageStart,
  anthropicStream,
  anthropicTextReply,
  anthropicToolUseBlock,
} from '@momonga/testkit';
import { postJson, readSse, userInput } from './gateway-helpers.ts';
import { REMOTE_CAPABILITIES, readFileTool, startAnthropicGateway, streamResponse, terminalOf } from './upstream-gateway-support.ts';

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

describe('anthropic thinking request from a declared adaptive form', () => {
  it.for(['low', 'medium', 'high'] as const)('sends adaptive thinking with output_config.effort %s', async (effort) => {
    const body = await sentFor(ADAPTIVE, effort);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort });
  });

  it('sends a level above the declared ones as the highest declared level', async () => {
    const body = await sentFor(ADAPTIVE, 'xhigh');
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'high' });
  });
});

describe('anthropic thinking request from a declared budget form', () => {
  it.for([
    ['low', 2048],
    ['medium', 4096],
    ['high', 6000],
  ] as const)('sends enabled thinking with the budget declared for %s', async ([effort, budget]) => {
    const body = await sentFor(BUDGET, effort);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: budget });
    expect(body.output_config).toBeUndefined();
  });

  it('sends the budget of the nearest declared level below a level with no budget', async () => {
    const body = await sentFor(GAPPED_BUDGET, 'medium');
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });

  it('sends the budget of the highest declared level for a level above it', async () => {
    const body = await sentFor(GAPPED_BUDGET, 'xhigh');
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 6000 });
  });

  it('keeps budget_tokens at least 1024 and below max_tokens when the request cap is under the declared budget', async () => {
    const body = await sentFor(BUDGET, 'high', { max_output_tokens: 3000 });
    expect(body.thinking?.type).toBe('enabled');
    expect(body.thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
    expect(body.thinking.budget_tokens).toBeLessThan(body.max_tokens);
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

    await readSse(
      await postJson(gateway.client, '/v1/responses', {
        model: 'fast',
        stream: true,
        tools: [readFileTool],
        reasoning: { effort: 'medium', summary: null },
        input: [...userInput('read a.txt'), ...output, { type: 'function_call_output', call_id: 'toolu_01', output: 'alpha' }],
      }),
    );

    const [firstBody, secondBody] = sentBodies(gateway);
    expect(firstBody.thinking).toEqual({ type: 'adaptive' });
    expect(secondBody.thinking).toEqual({ type: 'adaptive' });
    const assistant = secondBody.messages.find((message: any) => message.role === 'assistant');
    expect(assistant.content).toEqual([
      { type: 'thinking', thinking: THINKING, signature: SIGNATURE },
      { type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { path: 'a.txt' } },
    ]);
  });
});
