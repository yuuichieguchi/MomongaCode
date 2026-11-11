import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createUdsClient, fixedSocket } from '@momonga/foundation';
import { createGatewayClient } from '@momonga/runtime';
import { createFakeClock } from '@momonga/testkit';
import { START_MS, createFakePorts, createNotifier, launchService, makeLayout, onCleanup, openStore, sendJson, serviceOptions } from './helpers.ts';

describe('gateway unavailable (system timers)', () => {
  it('session create answers 503 gateway_unavailable with retry-after 1 while the gateway is down', async () => {
    const layout = makeLayout();
    const clock = createFakeClock(START_MS);
    const notifier = createNotifier();
    const store = openStore(layout.dbPath, clock, { notifier });
    const gateway = createGatewayClient({ resolveSocket: fixedSocket(path.join(layout.runDir, 'absent-gateway.sock')), clock, version: '0.0.0-test' });
    onCleanup(() => gateway.destroy());
    const ports = createFakePorts();
    ports.modelListing = () => gateway.listing({ signal: new AbortController().signal });
    const errors: unknown[] = [];
    const service = await launchService(serviceOptions({ store, clock, home: layout.home, socketPath: layout.socketPath, ports, notifier, errors }));
    onCleanup(() => service.close());
    const client = createUdsClient(fixedSocket(layout.socketPath), { connectTimeoutMs: 0 });
    onCleanup(() => client.close());

    const response = await sendJson(client, 'POST', '/v1/sessions', { body: { cwd: layout.project, env: { PATH: '/usr/bin:/bin' } } });

    expect({ status: response.status, body: response.json, retryAfter: response.headers['retry-after'] }).toEqual({
      status: 503,
      body: { error: { type: 'server_error', code: 'gateway_unavailable', message: expect.any(String) } },
      retryAfter: '1',
    });
    expect(errors).toEqual([]);
    expect(store.listSessions({ limit: 100, cursor: null }).sessions).toEqual([]);
  });
});
