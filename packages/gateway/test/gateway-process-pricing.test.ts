import { describe, expect, it } from 'vitest';
import { createUdsClient, createJsonLogger, systemClock } from '@momonga/foundation';
import { startGatewayProcess } from '@momonga/gateway';
import { openResponsesTextReply, registerCleanup, startFakeOpenResponses, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { PROCESS_VERSION, baseEnv, writeSettings } from './gateway-process-helpers.ts';
import { userInput } from './gateway-helpers.ts';

const CAPABILITIES = { contextWindow: 8192, maxOutputTokens: 1024 };
const PRICE = { provider: 'acme', model: 'local-fake', effectiveFrom: '2026-01-01', inputPerMTok: 1_000_000, outputPerMTok: 2_000_000, currency: 'USD' };

const startPricedGateway = async (context: CleanupContext, pricing: unknown[] | undefined) => {
  const upstream = await startFakeOpenResponses({ script: [openResponsesTextReply(['priced'])] });
  registerCleanup(context, () => upstream.close());
  const home = withTempDir(context, { asHome: true });
  writeSettings(home, {
    models: {
      aliases: { fast: ['local'] },
      targets: { local: { adapter: 'open-responses', provider: 'acme', model: 'local-fake', socketPath: upstream.socketPath, capabilities: CAPABILITIES } },
    },
    ...(pricing === undefined ? {} : { pricing }),
  });
  const handle = await startGatewayProcess({
    home,
    env: baseEnv(home),
    version: PROCESS_VERSION,
    logger: createJsonLogger({ service: 'gateway', clock: systemClock, stream: { write: () => true }, level: 'debug' }),
    stdout: { write: () => true },
  });
  registerCleanup(context, async () => {
    await handle.close();
  });
  const client = createUdsClient(handle.socketPath);
  registerCleanup(context, () => client.close());
  return client;
};

const costOfRun = async (client: ReturnType<typeof createUdsClient>) => {
  const created = await client.request({
    method: 'POST',
    path: '/v1/responses',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fast', input: userInput('hi'), metadata: { run_id: 'run-1' } }),
  });
  expect(created.status).toBe(200);
  await created.text();
  const cost = await client.request({
    method: 'POST',
    path: '/v1/momonga/cost',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runs: [{ runId: 'run-1', sessionId: 'session-1' }] }),
  });
  expect(cost.status).toBe(200);
  return (await cost.json()) as { report: { total: Record<string, unknown> } };
};

describe('cost reporting with user-configured prices', () => {
  it('prices a call by the entry the user declared for its provider and model', async (context) => {
    const client = await startPricedGateway(context, [PRICE]);
    const { report } = await costOfRun(client);
    expect(report.total).toMatchObject({ calls: 1, unpricedCalls: 0, amount: 17, currency: 'USD', priceVersions: ['2026-01-01'] });
  });

  it('keeps a call visible as unpriced when no price is declared', async (context) => {
    const client = await startPricedGateway(context, undefined);
    const { report } = await costOfRun(client);
    expect(report.total).toMatchObject({ calls: 1, unpricedCalls: 1, amount: 0, priceVersions: [] });
  });

  it('keeps a call unpriced when the declared price is for another model', async (context) => {
    const client = await startPricedGateway(context, [{ ...PRICE, model: 'another-model' }]);
    const { report } = await costOfRun(client);
    expect(report.total).toMatchObject({ calls: 1, unpricedCalls: 1, amount: 0 });
  });
});
