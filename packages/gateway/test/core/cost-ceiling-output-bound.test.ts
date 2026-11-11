import { describe, expect, it } from 'vitest';
import { definePriceTable } from '@momonga/observability';
import { createScriptedAdapter, openResponsesTextReply, textResponseEvents, usageOf } from '@momonga/testkit';
import { PRIMARY, postJson, readJson, startGateway, userInput } from '../gateway-helpers.ts';
import { REMOTE_CAPABILITIES, startOpenResponsesGateway } from '../upstream-gateway-support.ts';

const NANO_PER_TOKEN = 1000;
const INPUT_BOUND = 100;
const priceOf = (provider: string, model: string) => definePriceTable([{ provider, model, effectiveFrom: '1970-01-01', inputPerMTok: 1, outputPerMTok: 1, currency: 'USD' }]);
const ceilingFor = (outputTokens: number): number => (INPUT_BOUND + outputTokens) * NANO_PER_TOKEN;
const ceilingOf = (outputTokens: number) => ({ max_cost_nano: ceilingFor(outputTokens), max_input_tokens: INPUT_BOUND });

const scriptedGateway = (capabilities: Record<string, unknown>, calls = 1) =>
  startGateway({
    adapters: {
      [PRIMARY]: createScriptedAdapter({
        calls: Array.from({ length: calls }, () => ({ events: textResponseEvents({ model: 'scripted-primary', chunks: ['ok'], usage: usageOf(5, 2) }) })),
        capabilities,
        compactSummary: 'summary',
      }),
    },
    priceTable: priceOf('scripted', 'scripted-primary'),
  });

describe('the cost ceiling prices the output bound the wire carries (gateway-core-C01)', () => {
  it('serves a target with no output field under a ceiling that fits its gateway bound', async () => {
    const { client } = await scriptedGateway({ outputBoundField: 'none', maxOutputTokens: 1024 });

    const response = await readJson(await postJson(client, '/v1/responses', { model: PRIMARY, input: userInput('hi'), momonga: ceilingOf(1024) }));

    expect(response.status).toBe(200);
  });

  it('refuses a target with no output field when its gateway bound does not fit the ceiling', async () => {
    const { client } = await scriptedGateway({ outputBoundField: 'none', maxOutputTokens: 1024 });

    const response = await readJson(await postJson(client, '/v1/responses', { model: PRIMARY, input: userInput('hi'), momonga: ceilingOf(1023) }));

    expect([response.status, response.body.error.code]).toEqual([400, 'budget_exceeded']);
  });

  it('refuses a ceiling below the smallest answer', async () => {
    const { client } = await scriptedGateway({});

    const response = await readJson(await postJson(client, '/v1/responses', { model: PRIMARY, input: userInput('hi'), max_output_tokens: 500, momonga: ceilingOf(0) }));

    expect([response.status, response.body.error.code]).toEqual([400, 'budget_exceeded']);
  });

  it('caps the bound sent on the wire, reasoning headroom included, to the largest that fits the ceiling', async () => {
    const gateway = await startOpenResponsesGateway({
      script: [openResponsesTextReply(['ok'])],
      capabilities: { ...REMOTE_CAPABILITIES, reasoning: { control: 'none', headroomTokens: 300 } },
      priceTable: priceOf('scripted', 'upstream-model'),
    });

    const response = await readJson(
      await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', input: userInput('hi'), reasoning: { effort: 'high' }, max_output_tokens: 500, momonga: ceilingOf(500) }),
    );

    expect(response.status).toBe(200);
    const sent = gateway.fake.requests[0]?.body as Record<string, unknown>;
    expect(sent['max_output_tokens']).toBe(500);
  });

  it('sends the requested bound and its headroom unchanged when they fit the ceiling', async () => {
    const gateway = await startOpenResponsesGateway({
      script: [openResponsesTextReply(['ok'])],
      capabilities: { ...REMOTE_CAPABILITIES, reasoning: { control: 'none', headroomTokens: 300 } },
      priceTable: priceOf('scripted', 'upstream-model'),
    });

    const response = await readJson(
      await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', input: userInput('hi'), reasoning: { effort: 'high' }, max_output_tokens: 500, momonga: ceilingOf(800) }),
    );

    expect(response.status).toBe(200);
    expect((gateway.fake.requests[0]?.body as Record<string, unknown>)['max_output_tokens']).toBe(800);
  });

  it('caps the summary of a compaction to a ceiling that fits, instead of refusing it', async () => {
    const { client } = await scriptedGateway({ maxOutputTokens: 1024 }, 0);

    const response = await readJson(await postJson(client, '/v1/responses/compact', { model: PRIMARY, input: userInput('hi'), momonga: ceilingOf(200) }));

    expect(response.status).toBe(200);
  });
});
