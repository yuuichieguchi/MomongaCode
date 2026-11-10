import { describe, expect, it } from 'vitest';
import { definePriceTable } from '@momonga/observability';
import type { Usage } from '@momonga/protocol';
import { anthropicMessageEnd, anthropicMessageStart, anthropicStream, anthropicTextBlock } from '@momonga/testkit';
import { parseUpstreamChunk } from '../src/adapters/chat-completions/upstream-chunk.ts';
import { parseOpenResponsesEvent } from '../src/adapters/open-responses/events.ts';
import { modelCostOf } from '../src/core/model-cost.ts';
import { startAnthropicGateway, streamResponse, terminalOf } from './upstream-gateway-support.ts';

const ENTRY = { provider: 'scripted', model: 'upstream-model', effectiveFrom: '1970-01-01', inputPerMTok: 2, cachedInputPerMTok: 0.5, cacheWritePerMTok: 2.5, outputPerMTok: 8, currency: 'USD' as const };

const chatChunk = (usage: Record<string, unknown>): string => JSON.stringify({ choices: [], usage });

const openResponsesCompleted = (usage: Record<string, unknown>): string => JSON.stringify({ type: 'response.completed', response: { usage } });

const anthropicTurn = (start: Record<string, number>) =>
  anthropicStream([anthropicMessageStart(start), ...anthropicTextBlock(0, ['done']), ...anthropicMessageEnd('end_turn', { output_tokens: 7 })]);

const terminalUsageOf = (event: ReturnType<typeof parseOpenResponsesEvent>): Usage | undefined => (event.type === 'terminal' && 'usage' in event.terminal ? event.terminal.usage : undefined);

describe('a cache read the upstream never reported stays absent in the gateway', () => {
  it('chat completions: a usage without prompt_tokens_details carries no cached token count', () => {
    const { usage } = parseUpstreamChunk(chatChunk({ prompt_tokens: 100, completion_tokens: 2 }));
    expect(usage?.input_tokens).toBe(100);
    expect(usage?.input_tokens_details?.cached_tokens).toBeUndefined();
  });

  it('chat completions: prompt_tokens_details without cached_tokens carries no cached token count', () => {
    const { usage } = parseUpstreamChunk(chatChunk({ prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: {} }));
    expect(usage?.input_tokens).toBe(100);
    expect(usage?.input_tokens_details?.cached_tokens).toBeUndefined();
  });

  it('chat completions: a reported zero stays zero', () => {
    const { usage } = parseUpstreamChunk(chatChunk({ prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } }));
    expect(usage?.input_tokens_details?.cached_tokens).toBe(0);
  });

  it('open responses: a usage without input_tokens_details carries no cached token count', () => {
    const usage = terminalUsageOf(parseOpenResponsesEvent(openResponsesCompleted({ input_tokens: 100, output_tokens: 2 })));
    expect(usage?.input_tokens).toBe(100);
    expect(usage?.input_tokens_details?.cached_tokens).toBeUndefined();
  });

  it('open responses: a reported zero stays zero', () => {
    const usage = terminalUsageOf(parseOpenResponsesEvent(openResponsesCompleted({ input_tokens: 100, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } })));
    expect(usage?.input_tokens_details?.cached_tokens).toBe(0);
  });

  it('anthropic: a message without cache_read_input_tokens answers with the spec-required zero on the wire, marks the count not reported in the extension and has no cost', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicTurn({ input_tokens: 10, output_tokens: 1 })], priceTable: definePriceTable([ENTRY]) });
    const terminal = terminalOf(await streamResponse(gateway));
    expect(terminal.response.usage.input_tokens).toBe(10);
    expect(terminal.response.usage.input_tokens_details.cached_tokens).toBe(0);
    expect(terminal.response.momonga.cacheReadNotReported).toBe(true);
    expect('cost' in terminal.response.momonga).toBe(false);
  });

  it('anthropic: a reported zero stays zero and is priced', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicTurn({ input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 1 })], priceTable: definePriceTable([ENTRY]) });
    const terminal = terminalOf(await streamResponse(gateway));
    expect(terminal.response.usage.input_tokens_details.cached_tokens).toBe(0);
    expect('cacheReadNotReported' in terminal.response.momonga).toBe(false);
    expect(terminal.response.momonga.cost).toEqual({ amount: 0.000076, currency: 'USD', priceVersion: '1970-01-01' });
  });

  it('model cost: a call whose cache read was not reported is unpriced with the code cache_read_not_reported', () => {
    const usage = { input_tokens: 100, output_tokens: 2, total_tokens: 102, input_tokens_details: {}, output_tokens_details: { reasoning_tokens: 0 } } as unknown as Usage;
    expect(modelCostOf({ provider: 'scripted', model: 'upstream-model', billing: 'metered', usage, usageSource: 'reported', cacheWriteInputTokens: undefined, at: 0, table: definePriceTable([ENTRY]) })).toEqual({ kind: 'unpriced', code: 'cache_read_not_reported', reason: 'the upstream did not report the cache reads of the call' });
  });
});
