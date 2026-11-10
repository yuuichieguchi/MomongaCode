import { describe, expect, it } from 'vitest';
import { definePriceTable } from '@momonga/observability';
import { anthropicMessageEnd, anthropicMessageStart, anthropicStream, anthropicTextBlock, messageEvents, openResponsesStream, openingEvents, terminalEvent } from '@momonga/testkit';
import { startAnthropicGateway, startOpenResponsesGateway, streamResponse, terminalOf } from './upstream-gateway-support.ts';

const ENTRY = { provider: 'scripted', model: 'upstream-model', effectiveFrom: '1970-01-01', inputPerMTok: 2, cachedInputPerMTok: 0.5, cacheWritePerMTok: 2.5, outputPerMTok: 8, currency: 'USD' as const };

const cachingTurn = () =>
  anthropicStream([
    anthropicMessageStart({ input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 1 }),
    ...anthropicTextBlock(0, ['done']),
    ...anthropicMessageEnd('end_turn', { output_tokens: 7 }),
  ]);

const plainTurn = () =>
  anthropicStream([anthropicMessageStart({ input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 1 }), ...anthropicTextBlock(0, ['done']), ...anthropicMessageEnd('end_turn', { output_tokens: 7 })]);

describe('the cost of a call reaches the response as a momonga extension', () => {
  it('prices uncached input, cache read, cache write and output from the gateway price table, each at its own rate', async () => {
    const gateway = await startAnthropicGateway({ script: [cachingTurn()], priceTable: definePriceTable([ENTRY]) });
    const terminal = terminalOf(await streamResponse(gateway));

    expect(terminal.response.momonga.cost).toEqual({ amount: 0.000351, currency: 'USD', priceVersion: '1970-01-01' });
  });

  it('leaves the cost out when there is no price table, no entry for the target, or cache-write tokens without a cache-write price', async () => {
    const withoutTable = terminalOf(await streamResponse(await startAnthropicGateway({ script: [cachingTurn()] })));
    const otherModel = terminalOf(
      await streamResponse(await startAnthropicGateway({ script: [cachingTurn()], priceTable: definePriceTable([{ ...ENTRY, model: 'another-model' }]) })),
    );
    const { cacheWritePerMTok: _unpriced, ...withoutWritePrice } = ENTRY;
    const unpricedWrite = terminalOf(await streamResponse(await startAnthropicGateway({ script: [cachingTurn()], priceTable: definePriceTable([withoutWritePrice]) })));

    expect('cost' in withoutTable.response.momonga).toBe(false);
    expect('cost' in otherModel.response.momonga).toBe(false);
    expect('cost' in unpricedWrite.response.momonga).toBe(false);
    expect(unpricedWrite.response.momonga.cacheWriteInputTokens).toBe(100);
  });

  it('prices a call that wrote nothing to the cache with an entry that has no cache-write price', async () => {
    const { cacheWritePerMTok: _unpriced, ...withoutWritePrice } = ENTRY;
    const gateway = await startAnthropicGateway({ script: [plainTurn()], priceTable: definePriceTable([withoutWritePrice]) });
    const terminal = terminalOf(await streamResponse(gateway));

    expect(terminal.response.momonga.cost).toEqual({ amount: 0.000076, currency: 'USD', priceVersion: '1970-01-01' });
  });

  it('leaves the cost out and still answers when the provider reports more cached input than input, and when cached input has no cached rate', async () => {
    const message = messageEvents(['hi']);
    const inconsistent = { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 0 } };
    const gateway = await startOpenResponsesGateway({
      script: [openResponsesStream([...openingEvents(), ...message.events, terminalEvent({ kind: 'completed', usage: inconsistent }, [message.item])])],
      priceTable: definePriceTable([ENTRY]),
    });
    const terminal = terminalOf(await streamResponse(gateway));

    expect(terminal.type).toBe('response.completed');
    expect('cost' in terminal.response.momonga).toBe(false);

    const { cachedInputPerMTok: _noCachedRate, ...withoutCachedRate } = ENTRY;
    const cached = { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 0 } };
    const second = await startOpenResponsesGateway({
      script: [openResponsesStream([...openingEvents(), ...message.events, terminalEvent({ kind: 'completed', usage: cached }, [message.item])])],
      priceTable: definePriceTable([withoutCachedRate]),
    });
    expect('cost' in terminalOf(await streamResponse(second)).response.momonga).toBe(false);
  });

  it('prices a local target at nothing whether or not the table has an entry for it, like the cost report', async () => {
    const local = { targets: { remote: { model: 'upstream-model', kind: 'remote', billing: 'local' as const } }, aliases: { fast: ['remote'] } };
    const priced = terminalOf(
      await streamResponse(
        await startAnthropicGateway({ script: [plainTurn()], config: local, priceTable: definePriceTable([{ ...ENTRY, inputPerMTok: 0, cachedInputPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0 }]) }),
      ),
    );
    const unpriced = terminalOf(await streamResponse(await startAnthropicGateway({ script: [plainTurn()], config: local, priceTable: definePriceTable([]) })));

    expect(priced.response.momonga.cost).toEqual({ amount: 0, currency: 'USD', priceVersion: 'local' });
    expect(unpriced.response.momonga.cost).toEqual({ amount: 0, currency: 'USD', priceVersion: 'local' });
  });
});
