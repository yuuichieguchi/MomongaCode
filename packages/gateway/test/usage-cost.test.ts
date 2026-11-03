import { describe, expect, it } from 'vitest';
import { definePriceTable } from '@momonga/observability';
import { anthropicMessageEnd, anthropicMessageStart, anthropicStream, anthropicTextBlock } from '@momonga/testkit';
import { startAnthropicGateway, streamResponse, terminalOf } from './upstream-gateway-support.ts';

const ENTRY = { provider: 'scripted', model: 'upstream-model', effectiveFrom: '1970-01-01', inputPerMTok: 2, cachedInputPerMTok: 0.5, cacheWritePerMTok: 2.5, outputPerMTok: 8, currency: 'USD' as const };

const cachingTurn = () =>
  anthropicStream([
    anthropicMessageStart({ input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 1 }),
    ...anthropicTextBlock(0, ['done']),
    ...anthropicMessageEnd('end_turn', { output_tokens: 7 }),
  ]);

const plainTurn = () =>
  anthropicStream([anthropicMessageStart({ input_tokens: 10, output_tokens: 1 }), ...anthropicTextBlock(0, ['done']), ...anthropicMessageEnd('end_turn', { output_tokens: 7 })]);

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

  it('counts a local target priced at 0 in the table as priced, and a local target without an entry as unpriced', async () => {
    const local = { targets: { remote: { model: 'upstream-model', kind: 'remote', billing: 'local' as const } }, aliases: { fast: ['remote'] } };
    const priced = terminalOf(
      await streamResponse(
        await startAnthropicGateway({ script: [plainTurn()], config: local, priceTable: definePriceTable([{ ...ENTRY, inputPerMTok: 0, cachedInputPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 0 }]) }),
      ),
    );
    const unpriced = terminalOf(await streamResponse(await startAnthropicGateway({ script: [plainTurn()], config: local, priceTable: definePriceTable([]) })));

    expect(priced.response.momonga.cost).toEqual({ amount: 0, currency: 'USD', priceVersion: '1970-01-01' });
    expect('cost' in unpriced.response.momonga).toBe(false);
  });
});
