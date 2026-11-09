import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { createChatCompletionsAdapter, GATEWAY_CONFIG_DEFAULTS, unauthenticatedSource } from '@momonga/gateway';
import { createFakeClock } from '@momonga/testkit';
import { START_MS, expectErrorBody, getJson, postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';
import { driveTimers } from './retry-support.ts';
import { CC_CAPABILITIES, startFake } from './cc-support.ts';
import { UNCONFIGURED_NETWORK } from '@momonga/testkit';
import { UNDICI_DEFAULT_LIVENESS } from '@momonga/testkit';

const request = { model: 'fast', input: userInput('hi'), stream: false };

const refusedBaseUrl = async (): Promise<string> => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/v1`;
};

const SENDS_PER_BUDGET = 18;

const deadConfig = {
  aliases: { fast: ['dead'] },
  targets: { dead: { model: 'upstream-model' } },
  retry: GATEWAY_CONFIG_DEFAULTS.retry,
  breaker: GATEWAY_CONFIG_DEFAULTS.breaker,
};

describe('a target that refuses connections', () => {
  it('spends the whole budget on every request, before and after its breaker opens, and fails each with provider_unavailable', async () => {
    const baseUrl = await refusedBaseUrl();
    let connectAttempts = 0;
    const adapter = createChatCompletionsAdapter({ authSource: unauthenticatedSource, liveness: UNDICI_DEFAULT_LIVENESS, schemaDialect: () => 'json-schema-2020-12',
      resolveEndpoint: async () => {
        connectAttempts += 1;
        return { kind: 'tcp', baseUrl, network: UNCONFIGURED_NETWORK };
      },
      capabilities: async () => CC_CAPABILITIES,
      clock: createFakeClock(START_MS),
    });
    const harness = await startGateway({ adapters: { dead: adapter }, config: deadConfig });
    const requests = GATEWAY_CONFIG_DEFAULTS.breaker.failureThreshold + 1;

    for (let call = 1; call <= requests; call += 1) {
      const pending = postJson(harness.client, '/v1/responses', request);
      await driveTimers(harness, [pending]);
      const refused = await readJson(await pending);
      expect(refused.status).toBe(502);
      expectErrorBody(refused.body, { type: 'server_error', code: 'provider_unavailable' });
      expect(refused.body.error.message).toContain('the chat-completions upstream is unreachable');
      expect(connectAttempts).toBe(call * SENDS_PER_BUDGET);
    }
    expect((await getJson(harness.client, '/v1/momonga/health')).body.targets.dead).toMatchObject({ breaker: 'open' });
  });

  it('serves the next call as soon as the target comes back, without waiting out the cooldown', async () => {
    const baseUrl = await refusedBaseUrl();
    const fake = await startFake({ scenario: 'tools-ok' });
    let alive = false;
    const adapter = createChatCompletionsAdapter({ authSource: unauthenticatedSource, liveness: UNDICI_DEFAULT_LIVENESS, schemaDialect: () => 'json-schema-2020-12',
      resolveEndpoint: async () => (alive ? { kind: 'unix', socketPath: fake.socketPath } : { kind: 'tcp', baseUrl, network: UNCONFIGURED_NETWORK }),
      capabilities: async () => CC_CAPABILITIES,
      clock: createFakeClock(START_MS),
    });
    const harness = await startGateway({ adapters: { dead: adapter }, config: deadConfig });
    for (let call = 1; call <= GATEWAY_CONFIG_DEFAULTS.breaker.failureThreshold; call += 1) {
      const pending = postJson(harness.client, '/v1/responses', request);
      await driveTimers(harness, [pending]);
      expect((await readJson(await pending)).status).toBe(502);
    }

    alive = true;
    const served = await readJson(await postJson(harness.client, '/v1/responses', request));

    expect(served.status).toBe(200);
  });
});
