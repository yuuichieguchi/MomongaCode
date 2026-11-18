import { nodeFileSystemSync, systemRandom } from '@momonga/foundation';
import fs from 'node:fs';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { managedInstancePaths, momongaPaths, systemTiming } from '@momonga/foundation';
import { FM_SERVER } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeFm, fakeExec, testKernelLock, testProcessInspector, TEST_UNPROTECTED_LAUNCH } from '@momonga/testkit';
import { listManagedModel } from '../src/probe/probe-managed.ts';
import type { ManagedKeyReaderOptions, MeasureManagedServerOptions, ProbeManagedOptions } from '../src/probe/probe-managed.ts';
import { makeHome } from './gateway-process-helpers.ts';
import { FAKE_FM_LISTED_MODEL } from './fm-record-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

describe('the managed probe measures the model it is given', () => {
  it('takes the model as required input wherever the probe key is read or written', () => {
    expectTypeOf<ProbeManagedOptions['model']>().toEqualTypeOf<string>();
    expectTypeOf<MeasureManagedServerOptions['model']>().toEqualTypeOf<string>();
    expectTypeOf<ManagedKeyReaderOptions['model']>().toEqualTypeOf<string>();
  });

  it('finds the model a server program serves by its listing, without measuring it', async () => {
    const dir = makeHome();
    const fm = await createFakeFm({ dir });
    const paths = momongaPaths(dir, process.platform, {});
    const model = await listManagedModel({
      paths,
      lock: testKernelLock(),
      inspector: testProcessInspector(), random: systemRandom, fileSystem: nodeFileSystemSync,
      launch: TEST_UNPROTECTED_LAUNCH,
      instance: managedInstancePaths(paths, { owner: 'cli', purpose: 'probe', provider: 'apple' }),
      description: FM_SERVER,
      target: 'apple',
      binary: fm.binaryPath,
      readyTimeoutMs: FM_SERVER.ready.limitMs,
      env: { PATH: '/usr/bin:/bin', HOME: dir },
      signal: AbortSignal.timeout(REAL_PROCESS_TEST_TIMEOUT_MS),
      exec: fakeExec,
      isUsableBinary: async (binary: string) => fs.existsSync(binary),
      readStopGraceMs: () => 1_000,
      timers: systemTiming,
      onWarning: () => undefined,
    });
    expect(model).toBe(FAKE_FM_LISTED_MODEL);
  });
});
