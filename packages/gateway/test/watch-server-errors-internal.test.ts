import { fixedRolePort } from '@momonga/foundation';
import http from 'node:http';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as gatewayModule from '@momonga/gateway';
import { createGateway } from '@momonga/gateway';
import { createFakeClock, createFakeTimers, createScriptedAdapter } from '@momonga/testkit';
import { HMAC_KEY, START_MS, TEST_VERSION, buildConfig, makeDir, registerCleanup } from './gateway-helpers.ts';

describe('watchServerErrors is module-internal (B3)', () => {
  it('is not exported from @momonga/gateway', () => {
    expect('watchServerErrors' in gatewayModule).toBe(false);
  });

  it('a server error after ready is forwarded to onFatal via createGateway', async (context) => {
    const dir = makeDir();
    const clock = createFakeClock(START_MS);
    const servers: http.Server[] = [];
    const createServer = http.createServer.bind(http);
    const spy = vi.spyOn(http, 'createServer').mockImplementation(((...args: Parameters<typeof http.createServer>) => {
      const server = createServer(...args);
      servers.push(server);
      return server;
    }) as typeof http.createServer);
    const seen: Error[] = [];
    const gateway = await createGateway({
      role: fixedRolePort('serving'),
      random: () => 0.5,
      credentials: [],
      config: buildConfig(),
      adapters: { 'scripted/scripted-primary': createScriptedAdapter({ calls: [] }) },
      clock,
      timers: createFakeTimers(clock),
      dbPath: path.join(dir, 'state', 'gateway.db'),
      hmacKey: HMAC_KEY,
      socketPath: path.join(dir, 'gw.sock'),
      pid: process.pid,
      version: TEST_VERSION,
      onFatal: (error) => void seen.push(error),
    });
    registerCleanup(() => gateway.close());
    spy.mockRestore();
    const server = servers[0];
    if (server === undefined) throw new Error('no http server was created');
    const failure = new Error('server failure (injected)');
    server.emit('error', failure);
    expect(seen[0]).toBe(failure);
  });
});
