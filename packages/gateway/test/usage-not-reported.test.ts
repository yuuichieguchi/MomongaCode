import { describe, expect, expectTypeOf, it } from 'vitest';
import { definePriceTable } from '@momonga/observability';
import type { AdapterCompactResult, CompactResource, ModelCost, UnpricedOutcome, UsageSource } from '@momonga/protocol';
import { messageEvents, openResponsesStream, openResponsesTextReply, openingEvents, terminalEvent } from '@momonga/testkit';
import type { FakeScriptedReply } from '@momonga/testkit';
import { modelCostOf } from '../src/core/model-cost.ts';
import { ccAdapterFor } from './cc-compact-support.ts';
import { startFake } from './cc-support.ts';
import { postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';
import { startOpenResponsesGateway, streamResponse, terminalOf } from './upstream-gateway-support.ts';

const ENTRY = { provider: 'scripted', model: 'upstream-model', effectiveFrom: '1970-01-01', inputPerMTok: 2, cachedInputPerMTok: 0.5, outputPerMTok: 8, currency: 'USD' as const };
const TABLE = definePriceTable([ENTRY]);
const USAGE = { input_tokens: 10, output_tokens: 7, total_tokens: 17, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };

const pricingOf = (billing: 'metered' | 'local' | 'plan' | 'unknown', usageSource: UsageSource) =>
  modelCostOf({ provider: 'scripted', model: 'upstream-model', billing, usage: USAGE, usageSource, cacheWriteInputTokens: undefined, at: 0, table: TABLE } as Parameters<typeof modelCostOf>[0]);

describe('modelCostOf never prices an estimated usage (I-P6)', () => {
  it('gives usage_not_reported to a metered call whose usage is the estimate, and prices the same call when reported', () => {
    expect(pricingOf('metered', 'reported')).toEqual({ kind: 'priced', cost: { amount: 0.000076, units: '76000000000', currency: 'USD', priceVersion: '1970-01-01' } });
    expect(pricingOf('metered', 'estimated')).toMatchObject({ kind: 'unpriced', code: 'usage_not_reported' });
  });

  it('keeps local priced 0 and plan and unknown billing their codes when the usage is estimated', () => {
    expect(pricingOf('metered', 'estimated')).toMatchObject({ kind: 'unpriced', code: 'usage_not_reported' });
    expect(pricingOf('local', 'estimated')).toEqual({ kind: 'priced', cost: { amount: 0, units: '0', currency: 'USD', priceVersion: 'local' } });
    expect(pricingOf('plan', 'estimated')).toMatchObject({ kind: 'unpriced', code: 'plan' });
    expect(pricingOf('unknown', 'estimated')).toMatchObject({ kind: 'unpriced', code: 'unknown_billing' });
  });
});

describe('a response whose upstream sent no usage carries usage_not_reported', () => {
  it('on a completed response: estimated usage, unpriced usage_not_reported, no cost', async () => {
    const terminal = terminalOf(await streamResponse(await startOpenResponsesGateway({ script: [openResponsesTextReply(['hi'], null)], priceTable: TABLE })));

    expect(terminal.type).toBe('response.completed');
    expect(terminal.response.momonga.usageSource).toBe('estimated');
    expect(terminal.response.momonga.unpriced).toMatchObject({ code: 'usage_not_reported' });
    expect('cost' in terminal.response.momonga).toBe(false);
  });

  it('on an incomplete response: estimated usage, unpriced usage_not_reported, no cost', async () => {
    const message = messageEvents(['partial']);
    const reply = openResponsesStream([...openingEvents(), ...message.events, terminalEvent({ kind: 'incomplete', reason: 'max_output_tokens', usage: null }, [message.item])]);
    const terminal = terminalOf(await streamResponse(await startOpenResponsesGateway({ script: [reply], priceTable: TABLE })));

    expect(terminal.type).toBe('response.incomplete');
    expect(terminal.response.momonga.usageSource).toBe('estimated');
    expect(terminal.response.momonga.unpriced).toMatchObject({ code: 'usage_not_reported' });
    expect('cost' in terminal.response.momonga).toBe(false);
  });
});

describe('a compaction whose adapter estimated its usage carries usage_not_reported', () => {
  it('open-responses: the summary reported no usage', async () => {
    const gateway = await startOpenResponsesGateway({ script: [openResponsesTextReply(['The user asked for X.'], null)], priceTable: TABLE });
    const response = await readJson(await postJson(gateway.client, '/v1/responses/compact', { model: 'scripted/upstream-model', input: userInput('do X') }));

    expect(response.status).toBe(200);
    expect(response.body.momonga.unpriced).toMatchObject({ code: 'usage_not_reported' });
    expect('cost' in response.body.momonga).toBe(false);
  });

  it('chat-completions: the summary reported no usage', async () => {
    const withoutUsage: FakeScriptedReply = { kind: 'stream', chunks: [{ delta: { role: 'assistant', content: 'The user asked for X.' } }, { delta: {}, finishReason: 'stop' }] };
    const fake = await startFake({ scenario: 'tools-ok', usageReported: false, script: [withoutUsage] });
    const gateway = await startGateway({
      adapters: { 'scripted/system': ccAdapterFor(fake) },
      config: { chains: { 'scripted/system': ['scripted/system'] }, targets: { 'scripted/system': { kind: 'remote', billing: 'metered' } } },
      priceTable: definePriceTable([]),
    });
    const response = await readJson(await postJson(gateway.client, '/v1/responses/compact', { model: 'scripted/system', input: userInput('do X') }));

    expect(response.status).toBe(200);
    expect(response.body.momonga.unpriced).toMatchObject({ code: 'usage_not_reported' });
  });
});

describe('the compaction types state the source and always carry momonga', () => {
  it('AdapterCompactResult requires usageSource and CompactResource requires momonga', () => {
    expectTypeOf<AdapterCompactResult['usageSource']>().toEqualTypeOf<UsageSource>();
    expectTypeOf<Pick<CompactResource, 'momonga'>>().toEqualTypeOf<Required<Pick<CompactResource, 'momonga'>>>();
    expectTypeOf<CompactResource['momonga']>().toEqualTypeOf<{ target: string; cacheWriteInputTokens?: number; cacheReadNotReported?: true; cost?: ModelCost; unpriced?: UnpricedOutcome }>();
  });
});
