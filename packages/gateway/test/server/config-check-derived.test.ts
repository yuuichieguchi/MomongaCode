import { systemProcessPorts } from '../../src/process-ports.ts';
import { describe, expect, it, vi } from 'vitest';
import { createJsonLogger, systemClock, FIRST_GENERATION } from '@momonga/foundation';
import { startGatewayProcess } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, registerCleanup, registerOwned, startFakeOpenResponses, withTempDir, testLocks, createScriptedAdapter } from '@momonga/testkit';
import { PROCESS_VERSION, baseEnv, writeSettings, modelsOf, prepareHome } from '../gateway-process-helpers.ts';
import { startGateway } from '../gateway-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const CAPABILITIES = { contextWindow: 8192, maxOutputTokens: 1024 };

const startWith = async (context: Parameters<typeof registerCleanup>[0], target: Record<string, unknown>) => {
  const upstream = await startFakeOpenResponses({ script: [] });
  registerCleanup(context, () => upstream.close());
  const home = withTempDir(context, { asHome: true });
  prepareHome(home);
  writeSettings(home, { models: modelsOf({ local: { adapter: 'open-responses', provider: 'acme', model: 'local-fake', socketPath: upstream.socketPath, capabilities: CAPABILITIES, ...target } }) });
  const started = registerOwned(context, () => startGatewayProcess({...systemProcessPorts, signal: new AbortController().signal,  platform: process.platform,
    locks: testLocks(),
    generation: FIRST_GENERATION,
    home,
    env: baseEnv(home),
    version: PROCESS_VERSION,
    logger: createJsonLogger({ service: 'gateway', clock: systemClock, stream: { write: () => true }, level: 'debug' }),
    stdout: { write: () => true },
  }));
  return { started, upstream };
};

describe('the model rules of the gateway are the rules the settings accept, on every epoch', () => {
  it('starts a fixed gateway whose model waits no time for a free slot', async () => {
    const harness = await startGateway({
      adapters: { 'scripted/scripted-primary': createScriptedAdapter({ calls: [] }) },
      config: { targets: { 'scripted/scripted-primary': { admissionTimeoutMs: 0 } } },
    });
    expect(harness.socketPath).not.toBe('');
  });

  it('starts a derived epoch whose model waits no time for a free slot', async (context) => {
    const { started } = await startWith(context, { admissionTimeoutMs: 0 });
    const handle = await started;
    expect(handle.socketPath).not.toBe('');
  });

  it('refuses a derived epoch whose model allows no concurrent request, before any request is sent', async (context) => {
    const { started, upstream } = await startWith(context, { maxConcurrency: 0 });
    await expect(started).rejects.toThrow(/maxConcurrency/);
    expect(upstream.requests).toHaveLength(0);
  });
});
