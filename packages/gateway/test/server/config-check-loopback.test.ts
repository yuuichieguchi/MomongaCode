import path from 'node:path';
import { fixedRolePort } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers, createScriptedAdapter, testKernelLock } from '@momonga/testkit';
import { checkGatewayOptions } from '../../src/server/config-check.ts';
import { HMAC_KEY, START_MS, TEST_VERSION, buildConfig, makeDir, stateDbPath } from '../gateway-helpers.ts';

const checkDebugHost = (host: string): void => {
  const dir = makeDir();
  const clock = createFakeClock(START_MS);
  checkGatewayOptions({
    lock: testKernelLock(),
    role: fixedRolePort('serving'),
    random: () => 0.5,
    credentials: [],
    config: buildConfig(),
    adapters: { 'scripted/scripted-primary': createScriptedAdapter({ calls: [] }) },
    clock,
    timers: createFakeTimers(clock),
    dbPath: stateDbPath(dir),
    hmacKey: HMAC_KEY,
    socketPath: path.join(dir, 'gw.sock'),
    pid: process.pid,
    version: TEST_VERSION,
    debugTcp: { host, port: 0, token: 'tok' },
  });
};

describe('the debug listener host is judged by the one loopback classifier of foundation', () => {
  it.each(['127.0.0.1', '::1', '0:0:0:0:0:0:0:1', '[::1]', '::ffff:127.0.0.1', '::127.0.0.1', '64:ff9b::7f00:1'])('accepts the loopback address %s', (host) => {
    expect(() => checkDebugHost(host)).not.toThrow();
  });

  it.each(['10.0.0.1', '::ffff:10.0.0.1', '::10.0.0.1', '64:ff9b::a00:1', '0.0.0.0', '::', '127.0.0.1.evil.example', 'localhost'])('refuses %s', (host) => {
    expect(() => checkDebugHost(host)).toThrow(/loopback/);
  });
});
