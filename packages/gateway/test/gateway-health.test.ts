import { describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter } from '@momonga/protocol';
import { createScriptedAdapter } from '@momonga/testkit';
import { capabilityFailingAdapter } from './capability-failing-adapter.ts';
import { START_MS, TEST_VERSION, expectErrorBody, getJson, postJson, readJson, startGateway } from './gateway-helpers.ts';

describe('GET /v1/momonga/health', () => {
  it('reports ok, targets, version, apiVersion, pid, startedAt and state running', async () => {
    const primary = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { primary } });
    const response = await getJson(client, '/v1/momonga/health');
    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(['apiVersion', 'ok', 'pid', 'startedAt', 'state', 'targets', 'version']);
    expect(response.body.ok).toBe(true);
    expect(response.body.version).toBe(TEST_VERSION);
    expect(response.body.apiVersion).toBe(1);
    expect(response.body.pid).toBe(process.pid);
    expect(new Date(response.body.startedAt).getTime()).toBe(START_MS);
    expect(response.body.state).toBe('running');
    expect(response.body.targets.primary).toMatchObject({ ok: true, breaker: 'closed' });
  });

  it('answers 200 with ok false when a target is unhealthy', async () => {
    const sick: ProviderAdapter = {
      ...createScriptedAdapter({ calls: [] }),
      health: async () => ({ ok: false, reason: 'precondition_failed', detail: 'not ready' }),
    };
    const { client } = await startGateway({ adapters: { primary: sick } });
    const response = await getJson(client, '/v1/momonga/health');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(false);
    expect(response.body.targets.primary).toMatchObject({ ok: false, reason: 'precondition_failed', detail: 'not ready' });
    expect(response.body.state).toBe('running');
    expect(response.body.version).toBe(TEST_VERSION);
  });
});

describe('GatewayOptions.onError', () => {
  it('a plain error from capabilities() is listed unavailable and answered 200', async () => {
    const failure = new TypeError('capabilities exploded');
    const broken = capabilityFailingAdapter({ inner: createScriptedAdapter({ calls: [] }), fails: () => failure });
    const onError = vi.fn();
    const { client } = await startGateway({ adapters: { primary: broken }, onError });
    const response = await getJson(client, '/v1/momonga/models');
    expect(response.status).toBe(200);
    const listed = { toolCalling: { state: 'unavailable', status: 502, type: 'server_error', code: 'adapter_error', message: 'capabilities exploded' }, source: 'unprobed' };
    const entry = (response.body.data as Array<{ targets: string[]; capabilities: unknown; targetCapabilities: Record<string, unknown> }>).find((candidate) => candidate.targets.includes('primary'));
    expect(entry?.capabilities).toEqual(listed);
    expect(entry?.targetCapabilities['primary']).toEqual(listed);
    expect(onError).not.toHaveBeenCalled();
  });

  it('receives an unknown error before the gateway answers 500', async () => {
    const failure = new TypeError('capabilities exploded');
    const onError = vi.fn();
    const { client } = await startGateway({
      adapters: { primary: createScriptedAdapter({ calls: [] }) },
      onError,
      costReport: async () => {
        throw failure;
      },
    });
    const response = await readJson(await postJson(client, '/v1/momonga/cost', { runs: [], includeRunless: false }));
    expect(response.status).toBe(500);
    expectErrorBody(response.body, { type: 'server_error', code: 'internal_error' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'capabilities exploded' }));
  });

  it('is not called for a GatewayError answered with its own status', async () => {
    const onError = vi.fn();
    const { client } = await startGateway({ adapters: { primary: createScriptedAdapter({ calls: [] }) }, onError });
    const response = await getJson(client, '/v1/momonga/no-such-route');
    expect(response.status).toBe(404);
    expect(onError).not.toHaveBeenCalled();
  });
});
