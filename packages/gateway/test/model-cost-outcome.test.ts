import { describe, expect, it } from 'vitest';
import { definePriceTable } from '@momonga/observability';
import { anthropicMessageEnd, anthropicMessageStart, anthropicStream, anthropicTextBlock } from '@momonga/testkit';
import { modelCostOf } from '../src/core/model-cost.ts';
import { startAnthropicGateway, streamResponse, terminalOf } from './upstream-gateway-support.ts';

const ENTRY = { provider: 'scripted', model: 'upstream-model', effectiveFrom: '1970-01-01', inputPerMTok: 2, outputPerMTok: 8, currency: 'USD' as const };

const USAGE = { input_tokens: 10, output_tokens: 7, total_tokens: 17, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };

const plainTurn = () =>
  anthropicStream([anthropicMessageStart({ input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 1 }), ...anthropicTextBlock(0, ['done']), ...anthropicMessageEnd('end_turn', { output_tokens: 7 })]);

const billed = (billing: 'local' | 'plan') => ({ targets: { remote: { model: 'upstream-model', kind: 'remote', billing } }, aliases: { fast: ['remote'] } });

const outcomeOf = (billing: 'metered' | 'local' | 'plan' | 'unknown', table: ReturnType<typeof definePriceTable> | undefined) =>
  modelCostOf({ provider: 'scripted', model: 'upstream-model', billing, usage: USAGE, usageSource: 'reported', cacheWriteInputTokens: undefined, at: 0, table });

describe('modelCostOf returns the price outcome and never null', () => {
  it('returns the cost of a priced call as a priced outcome', () => {
    expect(outcomeOf('metered', definePriceTable([ENTRY]))).toEqual({ kind: 'priced', cost: { amount: 0.000076, currency: 'USD', priceVersion: '1970-01-01' } });
  });

  it('returns no_price_entry with the reason "no price table" when there is no price table', () => {
    expect(outcomeOf('metered', undefined)).toEqual({ kind: 'unpriced', code: 'no_price_entry', reason: 'no price table' });
  });

  it('returns the code plan for a plan call and unknown_billing for an unknown billing', () => {
    expect(outcomeOf('plan', definePriceTable([ENTRY]))).toMatchObject({ kind: 'unpriced', code: 'plan' });
    expect(outcomeOf('unknown', definePriceTable([ENTRY]))).toMatchObject({ kind: 'unpriced', code: 'unknown_billing' });
  });

  it('returns cache_read_not_reported for a metered call whose cache-read count is absent, and plan for a plan call without it', () => {
    const absent = { ...USAGE, input_tokens_details: {} };
    const at = (billing: 'metered' | 'plan') =>
      modelCostOf({ provider: 'scripted', model: 'upstream-model', billing, usage: absent, usageSource: 'reported', cacheWriteInputTokens: undefined, at: 0, table: definePriceTable([ENTRY]) });

    expect(at('metered')).toMatchObject({ kind: 'unpriced', code: 'cache_read_not_reported' });
    expect(at('plan')).toMatchObject({ kind: 'unpriced', code: 'plan' });
  });

  it('returns no null for any billing, with or without a table', () => {
    for (const billing of ['metered', 'local', 'plan', 'unknown'] as const) {
      for (const table of [undefined, definePriceTable([]), definePriceTable([ENTRY])]) {
        const outcome = outcomeOf(billing, table);
        expect(outcome).not.toBeNull();
        expect(['priced', 'unpriced']).toContain((outcome as { kind?: string } | null)?.kind);
      }
    }
  });
});

describe('the response records exactly one of cost and unpriced (I-P1)', () => {
  it('records unpriced no_price_entry and no cost when the gateway has no price table', async () => {
    const terminal = terminalOf(await streamResponse(await startAnthropicGateway({ script: [plainTurn()] })));

    expect(terminal.response.momonga.unpriced).toMatchObject({ code: 'no_price_entry' });
    expect('cost' in terminal.response.momonga).toBe(false);
  });

  it('records unpriced no_price_entry when the table has no entry for the target', async () => {
    const terminal = terminalOf(await streamResponse(await startAnthropicGateway({ script: [plainTurn()], priceTable: definePriceTable([{ ...ENTRY, model: 'another-model' }]) })));

    expect(terminal.response.momonga.unpriced).toMatchObject({ code: 'no_price_entry' });
    expect('cost' in terminal.response.momonga).toBe(false);
  });

  it('records unpriced plan and no cost for a plan target, even with a price entry for its model', async () => {
    const terminal = terminalOf(await streamResponse(await startAnthropicGateway({ script: [plainTurn()], config: billed('plan'), priceTable: definePriceTable([ENTRY]) })));

    expect(terminal.response.momonga.unpriced).toMatchObject({ code: 'plan' });
    expect('cost' in terminal.response.momonga).toBe(false);
  });

  it('records cost 0 at local and no unpriced for a local target, with no price table', async () => {
    const terminal = terminalOf(await streamResponse(await startAnthropicGateway({ script: [plainTurn()], config: billed('local') })));

    expect(terminal.response.momonga.cost).toEqual({ amount: 0, currency: 'USD', priceVersion: 'local' });
    expect('unpriced' in terminal.response.momonga).toBe(false);
  });

  it('records unpriced cache_read_not_reported and no cost when the upstream reports no cache-read count', async () => {
    const silentCacheTurn = anthropicStream([anthropicMessageStart({ input_tokens: 10, output_tokens: 1 }), ...anthropicTextBlock(0, ['done']), ...anthropicMessageEnd('end_turn', { output_tokens: 7 })]);
    const terminal = terminalOf(await streamResponse(await startAnthropicGateway({ script: [silentCacheTurn], priceTable: definePriceTable([ENTRY]) })));

    expect(terminal.response.momonga.unpriced).toMatchObject({ code: 'cache_read_not_reported' });
    expect('cost' in terminal.response.momonga).toBe(false);
  });

  it('records cost and no unpriced for a priced metered call', async () => {
    const terminal = terminalOf(await streamResponse(await startAnthropicGateway({ script: [plainTurn()], priceTable: definePriceTable([ENTRY]) })));

    expect(terminal.response.momonga.cost).toEqual({ amount: 0.000076, currency: 'USD', priceVersion: '1970-01-01' });
    expect('unpriced' in terminal.response.momonga).toBe(false);
    expect(outcomeOf('metered', undefined)).toMatchObject({ kind: 'unpriced' });
  });
});
