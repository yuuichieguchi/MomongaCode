import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createJsonLogger, FIRST_GENERATION } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, FAKE_OS_BUILD, createFakeClock, createFakeFm, createFakeTimers, fakeExec } from '@momonga/testkit';
import type { ManagedServerOptions } from '../src/managed/server.ts';
import { START_MS, makeDir } from './gateway-helpers.ts';
import { placeFakeFm } from './fm-record-support.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings, modelsOf } from './gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const servedOptions: ManagedServerOptions[] = [];

vi.mock('../src/managed/server.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/managed/server.ts')>();
  return {
    ...original,
    createManagedServer: (options: ManagedServerOptions) => {
      servedOptions.push(options);
      return original.createManagedServer(options);
    },
  };
});

const hostExec = async (file: string, args: readonly string[]) => {
  if (path.basename(file) === 'sw_vers') return { exitCode: 0, stdout: `${FAKE_OS_BUILD}\n`, stderr: '' };
  if (args[0] === 'license') return { exitCode: 0, stdout: 'Agreed', stderr: '' };
  if (args[0] === 'available') return { exitCode: 0, stdout: 'System model available', stderr: '' };
  return fakeExec(file, args);
};

const settingsWith = (managedServerStopGraceMs: number) => ({
  gateway: { managedServerStopGraceMs },
  models: modelsOf({ apple: { adapter: 'managed', server: 'fm', model: 'system' } }),
});

describe('the gateway process wires the settings file into its managed server stops begun outside a close (design 3.2)', () => {
  it('the managed server reads its stop grace at each stop begin from the user settings last loaded: a change is read after the next request loaded it', async () => {
    const fm = await createFakeFm({ dir: makeDir() });
    const home = makeHome();
    writeSettings(home, settingsWith(700));
    await placeFakeFm(home, fm.binaryPath);
    const clock = createFakeClock(START_MS);
    const handle = await launchGateway({
      generation: FIRST_GENERATION,
      home,
      env: baseEnv(home),
      version: PROCESS_VERSION,
      exec: hostExec,
      execWithStdin: async () => ({ exitCode: 0, stdout: '5\n', stderr: '' }),
      clock,
      timers: createFakeTimers(clock),
      logger: createJsonLogger({ service: 'gateway', clock, stream: { write: () => true } }),
    });
    const managed = servedOptions.find((options) => options.target === 'system');
    expect(managed).toBeDefined();
    expect(managed?.readStopGraceMs()).toBe(700);
    writeSettings(home, settingsWith(1500));
    expect(managed?.readStopGraceMs()).toBe(700);
    const listed = await clientFor(handle.socketPath).request({ method: 'GET', path: '/v1/models' });
    expect(listed.status).toBe(200);
    expect(managed?.readStopGraceMs()).toBe(1500);
  });
});
