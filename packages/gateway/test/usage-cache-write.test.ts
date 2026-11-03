import { describe, expect, it } from 'vitest';
import { anthropicMessageEnd, anthropicMessageStart, anthropicStream, anthropicTextBlock, messageEvents, openResponsesStream, openingEvents, terminalEvent } from '@momonga/testkit';
import { startAnthropicGateway, startOpenResponsesGateway, streamResponse, terminalOf } from './upstream-gateway-support.ts';

describe('the cache write a provider reports reaches the response as a momonga extension', () => {
  it('carries the Anthropic cache_creation_input_tokens next to the cached input it already reports', async () => {
    const gateway = await startAnthropicGateway({
      script: [
        anthropicStream([
          anthropicMessageStart({ input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 1 }),
          ...anthropicTextBlock(0, ['done']),
          ...anthropicMessageEnd('end_turn', { output_tokens: 7 }),
        ]),
      ],
    });
    const terminal = terminalOf(await streamResponse(gateway));

    expect(terminal.response.usage).toEqual({
      input_tokens: 160,
      output_tokens: 7,
      total_tokens: 167,
      input_tokens_details: { cached_tokens: 50 },
      output_tokens_details: { reasoning_tokens: 0 },
    });
    expect(terminal.response.momonga.cacheWriteInputTokens).toBe(100);
  });

  it('adds the cache write of every segment of a paused Anthropic turn', async () => {
    const gateway = await startAnthropicGateway({
      script: [
        anthropicStream([anthropicMessageStart({ input_tokens: 10, cache_creation_input_tokens: 30, output_tokens: 1 }), ...anthropicTextBlock(0, ['part one, ']), ...anthropicMessageEnd('pause_turn', { output_tokens: 2 })]),
        anthropicStream([anthropicMessageStart({ input_tokens: 5, cache_creation_input_tokens: 12, cache_read_input_tokens: 30, output_tokens: 1 }), ...anthropicTextBlock(0, ['part two']), ...anthropicMessageEnd('end_turn', { output_tokens: 3 })]),
      ],
    });
    const terminal = terminalOf(await streamResponse(gateway));

    expect(terminal.response.usage.input_tokens_details).toEqual({ cached_tokens: 30 });
    expect(terminal.response.momonga.cacheWriteInputTokens).toBe(42);
  });

  it('leaves the extension out when the provider reports no cache write, so absence never reads as a write of zero', async () => {
    const anthropic = await startAnthropicGateway({
      script: [anthropicStream([anthropicMessageStart({ input_tokens: 12, output_tokens: 1 }), ...anthropicTextBlock(0, ['plain']), ...anthropicMessageEnd('end_turn', { output_tokens: 3 })])],
    });
    const fromAnthropic = terminalOf(await streamResponse(anthropic));
    const message = messageEvents(['hi']);
    const usage = { input_tokens: 40, output_tokens: 9, total_tokens: 49, input_tokens_details: { cached_tokens: 24 }, output_tokens_details: { reasoning_tokens: 5 } };
    const openResponses = await startOpenResponsesGateway({
      script: [openResponsesStream([...openingEvents(), ...message.events, terminalEvent({ kind: 'completed', usage }, [message.item])])],
    });
    const fromOpenResponses = terminalOf(await streamResponse(openResponses));
    const reported = await startAnthropicGateway({
      script: [anthropicStream([anthropicMessageStart({ input_tokens: 12, cache_creation_input_tokens: 8, output_tokens: 1 }), ...anthropicTextBlock(0, ['cached']), ...anthropicMessageEnd('end_turn', { output_tokens: 3 })])],
    });

    expect('cacheWriteInputTokens' in fromAnthropic.response.momonga).toBe(false);
    expect(fromOpenResponses.response.usage).toEqual(usage);
    expect('cacheWriteInputTokens' in fromOpenResponses.response.momonga).toBe(false);
    expect(terminalOf(await streamResponse(reported)).response.momonga.cacheWriteInputTokens).toBe(8);
  });
});
