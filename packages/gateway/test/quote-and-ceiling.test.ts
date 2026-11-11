import { describe, expect, it } from 'vitest';
import { definePriceTable } from '@momonga/observability';
import { anthropicMessageEnd, anthropicMessageStart, anthropicStream, anthropicTextBlock } from '@momonga/testkit';
import { postJson } from './gateway-helpers.ts';
import { startAnthropicGateway, streamResponse, terminalOf } from './upstream-gateway-support.ts';

const MODEL = 'scripted/upstream-model';

const ENTRY = { provider: 'scripted', model: 'upstream-model', effectiveFrom: '2020-01-01', inputPerMTok: 2, cacheWritePerMTok: 2.5, cachedInputPerMTok: 0.5, outputPerMTok: 8, currency: 'USD' as const };

const turn = () => anthropicStream([anthropicMessageStart({ input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 1 }), ...anthropicTextBlock(0, ['done']), ...anthropicMessageEnd('end_turn', { output_tokens: 7 })]);

const quoteOf = async (gateway: Awaited<ReturnType<typeof startAnthropicGateway>>, body: unknown): Promise<{ status: number; body: any }> => {
  const response = await postJson(gateway.client, '/v1/momonga/quote', body);
  return { status: response.status, body: JSON.parse(await response.text()) };
};

describe('POST /v1/momonga/quote answers the largest prices of the models a request may be answered by', () => {
  it('quotes the larger of the input and cache-write price, the output price and the price version', async () => {
    const gateway = await startAnthropicGateway({ script: [], priceTable: definePriceTable([ENTRY]) });

    expect(await quoteOf(gateway, { model: MODEL })).toEqual({ status: 200, body: { model: MODEL, priced: true, inUnits: '2500000000', outUnits: '8000000000', priceVersions: ['2020-01-01'] } });
  });

  it('answers priced false when the model has no price entry, and when the gateway has no price table', async () => {
    const other = await startAnthropicGateway({ script: [], priceTable: definePriceTable([{ ...ENTRY, model: 'another-model' }]) });
    const none = await startAnthropicGateway({ script: [] });

    expect((await quoteOf(other, { model: MODEL })).body).toEqual({ model: MODEL, priced: false });
    expect((await quoteOf(none, { model: MODEL })).body).toEqual({ model: MODEL, priced: false });
  });

  it('quotes a local model at zero', async () => {
    const gateway = await startAnthropicGateway({ script: [], config: { targets: { [MODEL]: { kind: 'remote', billing: 'local' as const } } }, priceTable: definePriceTable([]) });

    expect((await quoteOf(gateway, { model: MODEL })).body).toEqual({ model: MODEL, priced: true, inUnits: '0', outUnits: '0', priceVersions: ['local'] });
  });

  it('refuses a body without a model, and a model it does not serve', async () => {
    const gateway = await startAnthropicGateway({ script: [], priceTable: definePriceTable([ENTRY]) });

    expect((await quoteOf(gateway, {})).status).toBe(400);
    expect((await quoteOf(gateway, { model: 'scripted/unknown' })).status).toBeGreaterThanOrEqual(400);
  });
});

describe('a model request that carries the most it may cost is checked against the price of the model that would answer it', () => {
  const ceiling = (maxCostNano: number, maxInputTokens: number, maxOutputTokens: number) => ({
    max_output_tokens: maxOutputTokens,
    momonga: { max_cost_nano: maxCostNano, max_input_tokens: maxInputTokens },
  });

  it('sends the request when its worst case is exactly the ceiling, and answers with the exact price units', async () => {
    const gateway = await startAnthropicGateway({ script: [turn()], priceTable: definePriceTable([ENTRY]) });

    const terminal = terminalOf(await streamResponse(gateway, ceiling(4_500_000, 1000, 250)));

    expect(terminal.type).toBe('response.completed');
    expect(terminal.response.momonga.cost).toEqual({ amount: 0.000076, units: '76000000000', currency: 'USD', priceVersion: '2020-01-01' });
    expect(gateway.fake.requests).toHaveLength(1);
  });

  const refusalOf = async (gateway: Awaited<ReturnType<typeof startAnthropicGateway>>, body: Record<string, unknown>): Promise<{ status: number; code: unknown; param: unknown }> => {
    const response = await postJson(gateway.client, '/v1/responses', { model: MODEL, stream: true, input: 'hello', ...body });
    const parsed = JSON.parse(await response.text()) as { error?: { code?: unknown; param?: unknown } };
    return { status: response.status, code: parsed.error?.code, param: parsed.error?.param };
  };

  it('caps the output bound to the largest that fits one nano below the worst case', async () => {
    const gateway = await startAnthropicGateway({ script: [turn()], priceTable: definePriceTable([ENTRY]) });

    expect(terminalOf(await streamResponse(gateway, ceiling(4_499_999, 1000, 250))).type).toBe('response.completed');
    expect((gateway.fake.requests[0]?.body as Record<string, unknown>)['max_tokens']).toBe(249);
  });

  it('refuses with budget_exceeded when not even one output token fits, before any upstream call', async () => {
    const gateway = await startAnthropicGateway({ script: [turn()], priceTable: definePriceTable([ENTRY]) });

    expect(await refusalOf(gateway, ceiling(2_507_999, 1000, 250))).toEqual({ status: 400, code: 'budget_exceeded', param: 'momonga.max_cost_nano' });
    expect(gateway.fake.requests).toHaveLength(0);
  });

  it('refuses with budget_exceeded when the model has no price, since its cost cannot be bounded', async () => {
    const gateway = await startAnthropicGateway({ script: [turn()], priceTable: definePriceTable([]) });

    expect(await refusalOf(gateway, ceiling(1_000_000_000, 1000, 250))).toEqual({ status: 400, code: 'budget_exceeded', param: 'momonga.max_cost_nano' });
    expect(gateway.fake.requests).toHaveLength(0);
  });

  it('refuses a ceiling that comes without the input bound, one that does not fit the largest answer of a request without an output bound, and one that is not a whole number', async () => {
    const gateway = await startAnthropicGateway({ script: [], priceTable: definePriceTable([ENTRY]) });
    const send = async (body: Record<string, unknown>): Promise<number> => (await postJson(gateway.client, '/v1/responses', { model: MODEL, stream: true, input: 'hello', ...body })).status;

    expect(await send({ max_output_tokens: 10, momonga: { max_cost_nano: 5 } })).toBe(400);
    expect(await send({ momonga: { max_cost_nano: 5, max_input_tokens: 5 } })).toBe(400);
    expect(await send({ max_output_tokens: 10, momonga: { max_cost_nano: 1.5, max_input_tokens: 5 } })).toBe(400);
    expect(await send({ max_output_tokens: 10, momonga: { max_input_tokens: 5 } })).toBe(400);
  });
});

describe('a compaction request that carries the most it may cost is checked the same way', () => {
  const compact = async (gateway: Awaited<ReturnType<typeof startAnthropicGateway>>, momonga: Record<string, unknown>): Promise<{ status: number; code: unknown; param: unknown }> => {
    const response = await postJson(gateway.client, '/v1/responses/compact', { model: MODEL, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do X' }] }], momonga });
    const parsed = JSON.parse(await response.text()) as { error?: { code?: unknown; param?: unknown } };
    return { status: response.status, code: parsed.error?.code, param: parsed.error?.param };
  };

  it('refuses with budget_exceeded a compaction whose worst case is above the ceiling, before any upstream call', async () => {
    const gateway = await startAnthropicGateway({ script: [turn()], priceTable: definePriceTable([ENTRY]) });

    expect(await compact(gateway, { max_summary_tokens: 64, max_cost_nano: 1, max_input_tokens: 1000 })).toEqual({ status: 400, code: 'budget_exceeded', param: 'momonga.max_cost_nano' });
    expect(gateway.fake.requests).toHaveLength(0);
  });

  it('refuses a ceiling that comes without the input bound, and one that no summary fits', async () => {
    const gateway = await startAnthropicGateway({ script: [], priceTable: definePriceTable([ENTRY]) });

    expect((await compact(gateway, { max_summary_tokens: 64, max_cost_nano: 5 })).status).toBe(400);
    expect((await compact(gateway, { max_cost_nano: 5, max_input_tokens: 5 })).code).toBe('budget_exceeded');
    expect(gateway.fake.requests).toHaveLength(0);
  });
});
