import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents } from '@momonga/testkit';
import { postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';

const body = { model: 'fast', input: userInput('hi') };
const key = { 'idempotency-key': 'k-usage-less' };

describe('an upstream that answers without usage', () => {
  it('gets estimated usage from the gateway, which stores that response and replays it under the same key without a second upstream call', async () => {
    const primary = createScriptedAdapter({
      calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['no usage here'], usage: null }) }, { events: textResponseEvents({ model: 'scripted-primary', chunks: ['second call'] }) }],
    });
    const { client } = await startGateway({ adapters: { primary } });

    const first = await readJson(await postJson(client, '/v1/responses', body, key));
    const second = await readJson(await postJson(client, '/v1/responses', body, key));

    expect(first.status).toBe(200);
    expect(first.body.usage).not.toBeNull();
    expect(first.body.usage.input_tokens).toBeGreaterThan(0);
    expect(first.body.momonga.usageSource).toBe('estimated');
    expect(second.body).toEqual(first.body);
    expect(primary.calls).toHaveLength(1);
  });
});
