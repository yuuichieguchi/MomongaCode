import { describe, expect, it, vi } from 'vitest';
import { createJsonLogger, systemClock, FIRST_GENERATION } from '@momonga/foundation';
import { startGatewayProcess } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, registerCleanup, startFakeOpenResponses, withTempDir, testLocks } from '@momonga/testkit';
import { PROCESS_VERSION, baseEnv, writeSettings, modelsOf, prepareHome } from '../gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const PRICE = { provider: 'acme', model: 'local-fake', effectiveFrom: '2026-01-01', inputPerMTok: 1, outputPerMTok: 2, currency: 'USD' };

describe('a pricing list the settings refuse stops the gateway before any part is built', () => {
  it('refuses a price entry listed twice with its setting path and builds no model part', async (context) => {
    const upstream = await startFakeOpenResponses({ script: [] });
    registerCleanup(context, () => upstream.close());
    const home = withTempDir(context, { asHome: true });
    prepareHome(home);
    writeSettings(home, {
      models: modelsOf({ local: { adapter: 'open-responses', provider: 'acme', model: 'local-fake', socketPath: upstream.socketPath, capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } } }),
      pricing: [PRICE, { ...PRICE, inputPerMTok: 9 }],
    });
    await expect(
      startGatewayProcess({
        locks: testLocks(),
        generation: FIRST_GENERATION,
        home,
        env: baseEnv(home),
        version: PROCESS_VERSION,
        logger: createJsonLogger({ service: 'gateway', clock: systemClock, stream: { write: () => true }, level: 'debug' }),
        stdout: { write: () => true },
      }),
    ).rejects.toThrow(/\/pricing\/1/);
    expect(upstream.requests).toHaveLength(0);
  });
});
