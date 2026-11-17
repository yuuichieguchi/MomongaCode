import { systemProcessPorts } from '../../src/process-ports.ts';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, fakeExec, registerOwned, testLocks } from '@momonga/testkit';
import { makeDir, switchableRole, registerCleanup } from '../gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, ccTarget, homePaths, makeHome, modelsOf, writeSettings } from '../gateway-process-helpers.ts';
import { startGatewayProcess } from '../../src/process.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

describe('a gateway whose home was removed while it started writes nothing back (gateway-core-C25, P-010)', () => {
  it('fails its start and leaves no gateway.db in a re-created home', async () => {
    const home = makeHome();
    writeSettings(home, { models: modelsOf({ local: ccTarget(path.join(makeDir(), 'up.sock'), { toolCalling: 'native' }) }) });
    const role = switchableRole('serving');
    const removals = { count: 0 };
    const start = registerOwned(registerCleanup, () => startGatewayProcess({...systemProcessPorts, signal: new AbortController().signal,  platform: process.platform,
      locks: testLocks(),
      generation: FIRST_GENERATION,
      home,
      env: baseEnv(home),
      version: PROCESS_VERSION,
      exec: fakeExec,
      role: {
        ...role,
        refresh: async () => {
          fs.rmSync(homePaths(home).root, { recursive: true, force: true });
          removals.count += 1;
          return role.refresh();
        },
      },
    }));

    await expect(start).rejects.toThrow();

    expect(removals.count).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(homePaths(home).db)).toBe(false);
    expect(fs.existsSync(homePaths(home).root)).toBe(false);
  });
});
