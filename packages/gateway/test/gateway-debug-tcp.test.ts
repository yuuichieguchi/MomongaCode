import fs from 'node:fs';
import path from 'node:path';
import { Agent, request } from 'undici';
import { describe, expect, it } from 'vitest';
import { createGateway } from '@momonga/gateway';
import type { GatewayOptions } from '@momonga/gateway';
import { createFakeClock, createFakeTimers, createScriptedAdapter } from '@momonga/testkit';
import { HMAC_KEY, START_MS, TEST_VERSION, buildConfig, expectErrorBody, getJson, makeDir, registerCleanup, startGateway } from './gateway-helpers.ts';

const DEBUG_TOKEN = 'momonga-debug-test-token';

const tcpGet = async (dispatcher: Agent, port: number, headers: Record<string, string> = {}) => {
  const response = await request(`http://127.0.0.1:${port}/v1/models`, { method: 'GET', headers, dispatcher });
  return { status: response.statusCode, body: (await response.body.json()) as unknown };
};

const constructWith = (debugTcp: { host: string; port: number; token: string }) => {
  const dir = makeDir();
  const clock = createFakeClock(START_MS);
  return {
    dir,
    attempt: (async () =>
      createGateway({
      random: () => 0.5,
      credentials: [],
      config: buildConfig(),
      adapters: { 'scripted/scripted-primary': createScriptedAdapter({ calls: [] }) },
      clock,
      timers: createFakeTimers(clock),
      dbPath: path.join(dir, 'state', 'gateway.db'),
      hmacKey: HMAC_KEY,
      socketPath: path.join(dir, 'gw.sock'),
      version: TEST_VERSION,
      debugTcp: debugTcp as unknown as NonNullable<GatewayOptions['debugTcp']>,
    }))(),
  };
};

describe('TCP debug listener', () => {
  it('requires the bearer token over TCP but not over the unix socket', async () => {
    const primary = createScriptedAdapter({ calls: [] });
    const { gateway, client } = await startGateway({
      adapters: { 'scripted/scripted-primary': primary },
      debugTcp: { host: '127.0.0.1', port: 0, token: DEBUG_TOKEN },
    });
    const agent = new Agent();
    registerCleanup(() => agent.close());
    const port = gateway.tcpPort;
    expect(typeof port).toBe('number');
    expect(port).toBeGreaterThan(0);

    const anonymous = await tcpGet(agent, port as number);
    expect(anonymous.status).toBe(401);
    expectErrorBody(anonymous.body, { type: 'invalid_request', code: 'unauthorized' });

    const wrong = await tcpGet(agent, port as number, { authorization: 'Bearer ' + 'wrong-token' });
    expect(wrong.status).toBe(401);

    const authorized = await tcpGet(agent, port as number, { authorization: 'Bearer ' + DEBUG_TOKEN });
    expect(authorized.status).toBe(200);

    expect((await getJson(client, '/v1/models')).status).toBe(200);
  });

  it('has no TCP port when debugTcp is not configured', async () => {
    const { gateway } = await startGateway({ adapters: { 'scripted/scripted-primary': createScriptedAdapter({ calls: [] }) } });
    expect(gateway.tcpPort).toBeUndefined();
  });

  it('rejects a non-loopback host at construction and leaves no socket behind', async () => {
    const { dir, attempt } = constructWith({ host: '0.0.0.0', port: 0, token: DEBUG_TOKEN });
    await expect(attempt).rejects.toThrow(/0\.0\.0\.0.*(loopback|127\.0\.0\.1)/);
    expect(fs.existsSync(path.join(dir, 'gw.sock'))).toBe(false);
  });

  it('rejects an empty token at construction', async () => {
    const { attempt } = constructWith({ host: '127.0.0.1', port: 0, token: '' });
    await expect(attempt).rejects.toThrow(/token/);
  });

  it('accepts ::1 as a loopback host', async () => {
    const { attempt } = constructWith({ host: '::1', port: 0, token: DEBUG_TOKEN });
    const gateway = await attempt;
    try {
      expect(gateway.tcpPort).toBeGreaterThan(0);
    } finally {
      await gateway.close();
    }
  });
});
