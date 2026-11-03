import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { createChatCompletionsAdapter, GATEWAY_CONFIG_DEFAULTS } from '@momonga/gateway';
import { createFakeClock } from '@momonga/testkit';
import { START_MS, expectErrorBody, postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';
import { CC_CAPABILITIES, startFake } from './cc-support.ts';

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
    const { client, clock } = await startGateway({
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

    const cooling = await readJson(await postJson(client, '/v1/responses', request));

    expect(cooling.status).toBe(503);
    expectErrorBody(cooling.body, { type: 'server_error', code: 'all_targets_unavailable' });
    expect(cooling.headers['retry-after']).toBe(String(GATEWAY_CONFIG_DEFAULTS.breaker.openMs / 1000));
    expect(cooling.body.error.message).toContain('the chat-completions upstream is unreachable');
    expect(connectAttempts).toBe(GATEWAY_CONFIG_DEFAULTS.breaker.failureThreshold);

    clock.advance(GATEWAY_CONFIG_DEFAULTS.breaker.openMs);
    const trial = await readJson(await postJson(client, '/v1/responses', request));
    expect(trial.status).toBe(502);
    expect(connectAttempts).toBe(GATEWAY_CONFIG_DEFAULTS.breaker.failureThreshold + 1);

    const dead = await readJson(await postJson(client, '/v1/responses', request));

    expect(dead.status).toBe(503);
    expectErrorBody(dead.body, { type: 'server_error', code: 'all_targets_unreachable' });
    expect(dead.body.error.message).toContain('dead');
    expect(dead.body.error.message).toContain('the chat-completions upstream is unreachable');
    expect(connectAttempts).toBe(GATEWAY_CONFIG_DEFAULTS.breaker.failureThreshold + 1);
  });

  it('serves the call again when the target comes back within the cooldown', async () => {
    const baseUrl = await refusedBaseUrl();
    const fake = await startFake({ scenario: 'tools-ok' });
    let alive = false;
    const adapter = createChatCompletionsAdapter({
      resolveEndpoint: async () => (alive ? { kind: 'unix', socketPath: fake.socketPath } : { kind: 'tcp', baseUrl }),
      toolCalling: () => 'native',
      capabilities: async () => CC_CAPABILITIES,
      clock: createFakeClock(START_MS),
    });
    const { client, clock } = await startGateway({
      adapters: { dead: adapter },
      config: {
        aliases: { fast: ['dead'] },
        targets: { dead: { model: 'upstream-model' } },
        retry: { maxAttempts: 1 },
        breaker: GATEWAY_CONFIG_DEFAULTS.breaker,
      },
    });
    for (let call = 1; call <= GATEWAY_CONFIG_DEFAULTS.breaker.failureThreshold; call += 1) {
      await readJson(await postJson(client, '/v1/responses', request));
    }
    expect((await readJson(await postJson(client, '/v1/responses', request))).status).toBe(503);

    alive = true;
    clock.advance(GATEWAY_CONFIG_DEFAULTS.breaker.openMs);
    const served = await readJson(await postJson(client, '/v1/responses', request));

    expect(served.status).toBe(200);
  });
});
