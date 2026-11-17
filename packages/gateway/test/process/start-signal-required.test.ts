import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, fakeExec, registerOwned, testLocks } from '@momonga/testkit';
import { makeDir, registerCleanup } from '../gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, ccTarget, homePaths, makeHome, modelsOf, writeSettings } from '../gateway-process-helpers.ts';
import { startGatewayProcess } from '../../src/process.ts';
import { systemProcessPorts } from '../../src/process-ports.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

describe('a gateway start is bound to the signal of the asker that starts it (gateway-core-G2)', () => {
  it('refuses to start, and writes nothing, when its signal is already aborted before the home is resolved', async () => {
    const home = makeHome();
    writeSettings(home, { models: modelsOf({ local: ccTarget(path.join(makeDir(), 'up.sock'), { toolCalling: 'native' }) }) });
    const asker = new AbortController();
    asker.abort(new Error('the asker is gone'));
    const start = registerOwned(registerCleanup, () =>
      startGatewayProcess({
        ...systemProcessPorts,
        signal: asker.signal,
        platform: process.platform,
        locks: testLocks(),
        generation: FIRST_GENERATION,
        home,
        env: baseEnv(home),
        version: PROCESS_VERSION,
        exec: fakeExec,
      }),
    );

    await expect(start).rejects.toThrow();
    expect(fs.existsSync(homePaths(home).db)).toBe(false);
  });

  it('refuses a start that names no signal at all: a start without an asker does not exist', async () => {
    const home = makeHome();
    writeSettings(home, { models: modelsOf({ local: ccTarget(path.join(makeDir(), 'up.sock'), { toolCalling: 'native' }) }) });
    const unbound = {
      ...systemProcessPorts,
      platform: process.platform,
      locks: testLocks(),
      generation: FIRST_GENERATION,
      home,
      env: baseEnv(home),
      version: PROCESS_VERSION,
      exec: fakeExec,
    } as unknown as Parameters<typeof startGatewayProcess>[0];
    await expect(registerOwned(registerCleanup, () => startGatewayProcess(unbound))).rejects.toThrow();
  });
});
