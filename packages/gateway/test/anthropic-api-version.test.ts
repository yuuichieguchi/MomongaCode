import { describe, expect, it } from 'vitest';
import { anthropicCountTokensReply, anthropicTextReply } from '@momonga/testkit';
import { postJson, readJson, readSse, userInput } from './gateway-helpers.ts';
import { startAnthropicGateway } from './upstream-gateway-support.ts';
import type { AnthropicApiVersion } from '@momonga/protocol';

const versionsSent = (gateway: Awaited<ReturnType<typeof startAnthropicGateway>>): unknown[] =>
  gateway.fake.requests.map((request) => request.headers['anthropic-version']);

const gatewayWith = (apiVersion: AnthropicApiVersion | undefined, script: Parameters<typeof startAnthropicGateway>[0]['script']) =>
  startAnthropicGateway({ ...(script === undefined ? {} : { script }), ...(apiVersion === undefined ? {} : { apiVersion }) });

const cases: ReadonlyArray<{ label: string; apiVersion: AnthropicApiVersion | undefined; expected: AnthropicApiVersion }> = [
  { label: 'a target with no declared version', apiVersion: undefined, expected: '2026-10-21' },
  { label: 'a target declaring 2026-10-21', apiVersion: '2026-10-21', expected: '2026-10-21' },
  { label: 'a target declaring 2023-06-01', apiVersion: '2023-06-01', expected: '2023-06-01' },
];

describe('the anthropic-version header is the target API version on every upstream request', () => {
  it.for(cases)('$label sends $expected on a non-streamed create', async ({ apiVersion, expected }) => {
    const gateway = await gatewayWith(apiVersion, [anthropicTextReply(['ok'])]);
    const response = await readJson(await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', input: userInput('hi') }));
    expect(response.status).toBe(200);
    expect(versionsSent(gateway)).toEqual([expected]);
  });

  it.for(cases)('$label sends $expected on a streamed create', async ({ apiVersion, expected }) => {
    const gateway = await gatewayWith(apiVersion, [anthropicTextReply(['ok'])]);
    const frames = await readSse(await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', stream: true, input: userInput('hi') }));
    expect(frames.at(-1)?.data.type).toBe('response.completed');
    expect(versionsSent(gateway)).toEqual([expected]);
  });

  it.for(cases)('$label sends $expected on count_tokens', async ({ apiVersion, expected }) => {
    const gateway = await gatewayWith(apiVersion, [anthropicCountTokensReply(42)]);
    const response = await readJson(await postJson(gateway.client, '/v1/momonga/count_tokens', { model: 'scripted/upstream-model', input: userInput('hi') }));
    expect(response.status).toBe(200);
    expect(gateway.fake.requests.map((request) => request.path)).toEqual(['/v1/messages/count_tokens']);
    expect(versionsSent(gateway)).toEqual([expected]);
  });
});
