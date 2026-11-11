import { fixedRolePort } from '@momonga/foundation';
import path from 'node:path';
import { Agent, request } from 'undici';
import { describe, expect, it } from 'vitest';
import { createGateway } from '@momonga/gateway';
import { createFakeClock, createFakeTimers, createScriptedAdapter } from '@momonga/testkit';
import { isLoopbackAddress } from '../src/server/config-check.ts';
import { HMAC_KEY, START_MS, TEST_VERSION, buildConfig, makeDir, registerCleanup, startGateway } from './gateway-helpers.ts';

const construct = (overrides: { hmacKey?: Uint8Array; debugTcp?: { host: string; port: number; token: string } }) => {
  const dir = makeDir();
  const clock = createFakeClock(START_MS);
  return createGateway({
    role: fixedRolePort('serving'),
    random: () => 0.5,
    credentials: [],
    config: buildConfig(),
    adapters: { 'scripted/scripted-primary': createScriptedAdapter({ calls: [] }) },
    clock,
    timers: createFakeTimers(clock),
    dbPath: path.join(dir, 'state', 'gateway.db'),
    hmacKey: overrides.hmacKey ?? HMAC_KEY,
    socketPath: path.join(dir, 'gw.sock'),
    pid: process.pid,
    version: TEST_VERSION,
    ...(overrides.debugTcp === undefined ? {} : { debugTcp: overrides.debugTcp }),
  });
};

describe('hmacKey strength', () => {
  it('rejects a key shorter than 32 bytes', async () => {
    await expect(construct({ hmacKey: Buffer.alloc(31, 1) })).rejects.toThrow(/32 bytes/);
  });

  it('accepts a key of exactly 32 bytes', async () => {
    const gateway = await construct({ hmacKey: Buffer.alloc(32, 1) });
    await gateway.close();
  });
});

describe('debug listener host', () => {
  it.each(['localhost', '[::1]', '0.0.0.0', '127.0.0.1.evil.example', '128.0.0.1', '127.0.0.256'])('rejects %s', async (host) => {
    await expect(construct({ debugTcp: { host, port: 0, token: 'tok' } })).rejects.toThrow(/loopback/);
  });

  it.each(['127.0.0.1', '127.0.0.2', '127.255.255.254', '::1'])('recognises %s as a loopback address', (address) => {
    expect(isLoopbackAddress(address)).toBe(true);
  });

  it.each(['localhost', '[::1]', '::ffff:127.0.0.1', '10.0.0.1', '127.0.0.1 '])('does not recognise %s', (address) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });
});

describe('bearer scheme', () => {
  it('accepts a case-insensitive Bearer scheme', async () => {
    const { gateway } = await startGateway({
      adapters: { 'scripted/scripted-primary': createScriptedAdapter({ calls: [] }) },
      debugTcp: { host: '127.0.0.1', port: 0, token: 'momonga-debug-test-token' },
    });
    const agent = new Agent();
    registerCleanup(() => agent.close());
    for (const scheme of ['bearer', 'BEARER', 'Bearer']) {
      const response = await request(`http://127.0.0.1:${gateway.tcpPort}/v1/models`, {
        method: 'GET',
        headers: { authorization: `${scheme} momonga-debug-test-token` },
        dispatcher: agent,
      });
      await response.body.text();
      expect(response.statusCode).toBe(200);
    }
  });
});

describe('readerStallMs', () => {
  it('must be a positive integer', async () => {
    const dir = makeDir();
    const clock = createFakeClock(START_MS);
    const config = buildConfig({ limits: { readerStallMs: 0 } });
    await expect(
      createGateway({
        role: fixedRolePort('serving'),
        random: () => 0.5,
        credentials: [],
        config,
        adapters: { 'scripted/scripted-primary': createScriptedAdapter({ calls: [] }) },
        clock,
        timers: createFakeTimers(clock),
        dbPath: path.join(dir, 'state', 'gateway.db'),
        hmacKey: HMAC_KEY,
        socketPath: path.join(dir, 'gw.sock'),
        pid: process.pid,
        version: TEST_VERSION,
      }),
    ).rejects.toThrow(/readerStallMs/);
  });
});
