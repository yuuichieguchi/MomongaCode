import { systemProcessPorts } from '../src/process-ports.ts';
import { describe, expect, it, vi } from 'vitest';
import { createUdsClient, createJsonLogger, systemClock, FIRST_GENERATION, fixedSocket } from '@momonga/foundation';
import { startGatewayProcess } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, openResponsesTextReply, registerCleanup, startFakeOpenResponses, usageOf, withTempDir, registerOwned, testLocks } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { PROCESS_VERSION, baseEnv, writeSettings, modelsOf, prepareHome } from './gateway-process-helpers.ts';
import { userInput } from './gateway-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const CAPABILITIES = { contextWindow: 8192, maxOutputTokens: 1024 };
const PRICE = { provider: 'acme', model: 'local-fake', effectiveFrom: '2026-01-01', inputPerMTok: 1_000_000, outputPerMTok: 2_000_000, currency: 'USD' };

const startPricedGateway = async (context: CleanupContext, pricing: unknown[] | undefined, billing?: 'local') => {
  const upstream = await startFakeOpenResponses({ script: [openResponsesTextReply(['priced'], usageOf(11, 3))] });
  registerCleanup(context, () => upstream.close());
  const home = withTempDir(context, { asHome: true });
  prepareHome(home);
  writeSettings(home, {
    models: modelsOf({ local: { adapter: 'open-responses', provider: 'acme', model: 'local-fake', socketPath: upstream.socketPath, capabilities: CAPABILITIES, ...(billing === undefined ? {} : { billing }) } }),
    ...(pricing === undefined ? {} : { pricing }),
  });
  const handle = await registerOwned(context, () => startGatewayProcess({...systemProcessPorts, signal: new AbortController().signal,  platform: process.platform,
    locks: testLocks(),
    generation: FIRST_GENERATION,
    home,
    env: baseEnv(home),
    version: PROCESS_VERSION,
    logger: createJsonLogger({ service: 'gateway', clock: systemClock, stream: { write: () => true }, level: 'debug' }),
    stdout: { write: () => true },
  }));
  registerCleanup(context, async () => {
    await handle.close();
  });
  const client = createUdsClient(fixedSocket(handle.socketPath), { connectTimeoutMs: 0 });
  registerCleanup(context, () => client.close());
  return client;
};

const recordOfCall = async (client: ReturnType<typeof createUdsClient>): Promise<{ cost?: Record<string, unknown>; unpriced?: Record<string, unknown> }> => {
  const created = await client.request({
    method: 'POST',
    path: '/v1/responses',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'acme/local-fake', input: userInput('hi'), metadata: { run_id: 'run-1' } }),
  });
  expect(created.status).toBe(200);
  return ((await created.json()) as { momonga: { cost?: Record<string, unknown>; unpriced?: Record<string, unknown> } }).momonga;
};

describe('the cost of a call is computed once, when it is answered, with the prices the user configured', () => {
  it('prices a call by the entry the user declared for its provider and model', async (context) => {
    const client = await startPricedGateway(context, [PRICE]);
    const record = await recordOfCall(client);
    expect(record.cost).toMatchObject({ amount: 17, currency: 'USD', priceVersion: '2026-01-01' });
    expect(record.unpriced).toBeUndefined();
  });

  it('answers a call as unpriced when no price is declared', async (context) => {
    const client = await startPricedGateway(context, undefined);
    const record = await recordOfCall(client);
    expect(record.unpriced).toMatchObject({ code: 'no_price_entry' });
    expect(record.cost).toBeUndefined();
  });

  it('answers a call to a target the user declared local at no cost and not as unpriced', async (context) => {
    const client = await startPricedGateway(context, undefined, 'local');
    const record = await recordOfCall(client);
    expect(record.cost).toMatchObject({ amount: 0, units: '0', priceVersion: 'local' });
    expect(record.unpriced).toBeUndefined();
  });

  it('answers a call as unpriced when the declared price is for another model', async (context) => {
    const client = await startPricedGateway(context, [{ ...PRICE, model: 'another-model' }]);
    const record = await recordOfCall(client);
    expect(record.unpriced).toMatchObject({ code: 'no_price_entry' });
  });
});
