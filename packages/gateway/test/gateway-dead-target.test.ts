import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { createChatCompletionsAdapter, GATEWAY_CONFIG_DEFAULTS } from '@momonga/gateway';
import { createFakeClock } from '@momonga/testkit';
import { START_MS, expectErrorBody, postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';
import { CC_CAPABILITIES } from './cc-support.ts';

const request = { model: 'fast', input: userInput('hi'), stream: false };

const refusedBaseUrl = async (): Promise<string> => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/v1`;
};

describe('a target that refuses connections', () => {
  it('opens its breaker after the configured number of failures and then fails at once naming the cause', async () => {
    const baseUrl = await refusedBaseUrl();
    let connectAttempts = 0;
    const adapter = createChatCompletionsAdapter({
      resolveEndpoint: async () => {
        connectAttempts += 1;
        return { kind: 'tcp', baseUrl };
      },
      toolCalling: () => 'native',
      capabilities: async () => CC_CAPABILITIES,
      clock: createFakeClock(START_MS),
    });
    const { client } = await startGateway({
      adapters: { dead: adapter },
      config: {
        aliases: { fast: ['dead'] },
        targets: { dead: { model: 'upstream-model' } },
        retry: { maxAttempts: 1 },
        breaker: GATEWAY_CONFIG_DEFAULTS.breaker,
      },
    });

    for (let call = 1; call <= GATEWAY_CONFIG_DEFAULTS.breaker.failureThreshold; call += 1) {
      const refused = await readJson(await postJson(client, '/v1/responses', request));
      expect(refused.status).toBe(502);
      expectErrorBody(refused.body, { type: 'server_error', code: 'provider_unavailable' });
    }
    expect(connectAttempts).toBe(GATEWAY_CONFIG_DEFAULTS.breaker.failureThreshold);

    const open = await readJson(await postJson(client, '/v1/responses', request));

    expect(open.status).toBe(503);
    expectErrorBody(open.body, { type: 'server_error', code: 'all_targets_unreachable' });
    expect(open.body.error.message).toContain('dead');
    expect(open.body.error.message).toContain('the chat-completions upstream is unreachable');
    expect(connectAttempts).toBe(GATEWAY_CONFIG_DEFAULTS.breaker.failureThreshold);
  });
});
