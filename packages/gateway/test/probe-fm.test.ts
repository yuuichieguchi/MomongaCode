import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBinaryHashCache, managedInstancePaths, momongaPaths } from '@momonga/foundation';
import { loadProbeRecord, managedRecordPath, probeManagedFm } from '@momonga/gateway';
import { FM_SERVER } from '@momonga/protocol';
import { FAKE_OS_BUILD, REAL_PROCESS_TEST_TIMEOUT_MS, createFakeFm, fakeExec, testKernelLock, testProcessInspector } from '@momonga/testkit';
import { makeHome } from './gateway-process-helpers.ts';
import { FAKE_FM_LISTED_MODEL, FM_CURRENCY, fmRecordKey } from './fm-record-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const setup = async () => {
  const dir = makeHome();
  const fm = await createFakeFm({ dir });
  const paths = momongaPaths(dir, process.platform, {});
  const instance = managedInstancePaths(paths, { owner: 'cli', purpose: 'probe', provider: 'apple' });
  return { dir, binary: fm.binaryPath, paths, instance };
};

const options = (context: Awaited<ReturnType<typeof setup>>, warnings: string[] = []) => ({
  platform: process.platform,
  paths: context.paths,
  instance: context.instance,
  description: FM_SERVER,
  target: 'apple',
  model: FAKE_FM_LISTED_MODEL,
  binary: context.binary,
  readyTimeoutMs: FM_SERVER.ready.limitMs,
  env: { PATH: '/usr/bin:/bin', HOME: context.dir },
  samples: 2,
  signal: AbortSignal.timeout(REAL_PROCESS_TEST_TIMEOUT_MS),
  exec: fakeExec,
  hashes: createBinaryHashCache(),
  lock: testKernelLock(),
  inspector: testProcessInspector(),
  isUsableBinary: async (binary: string) => fs.existsSync(binary),
  readStopGraceMs: () => 1_000,
  onWarning: (message: string) => void warnings.push(message),
});

describe('probeManagedFm', () => {
  it('serves fm on its own instance socket, probes it and records the report under its probe key', async () => {
    const context = await setup();

    const result = await probeManagedFm(options(context));

    const key = fmRecordKey(createHash('sha256').update(fs.readFileSync(context.binary)).digest('hex'), FAKE_OS_BUILD);
    expect(result.recordFile).toBe(managedRecordPath(context.paths.probe, key));
    expect(result.report.health).toEqual({ ok: true });
    expect(['native', 'constrained', 'none']).toContain(result.toolCalling);
    expect(await loadProbeRecord(context.paths.probe, key, FM_CURRENCY, 'apple')).toEqual(result.report);
    expect(fs.existsSync(context.instance.socketPath)).toBe(false);
  });

  it('reads the probe key on the OS it is given and records nothing when that OS has no build reader', async () => {
    const context = await setup();

    const failure = await probeManagedFm({ ...options(context), platform: 'aix' }).catch((error: unknown) => error);

    expect(String(failure)).toContain('no OS build reader exists on aix');
    expect(fs.existsSync(context.paths.probe) ? fs.readdirSync(context.paths.probe).filter((name) => name.endsWith('.json')) : []).toEqual([]);
  });

  it('records nothing and reports the remedy when fm is not licensed', async () => {
    const context = await setup();
    const unlicensed = path.join(context.dir, 'unlicensed-fm');
    fs.writeFileSync(unlicensed, '#!/bin/sh\nexit 69\n', { mode: 0o755 });

    const failure = await probeManagedFm({ ...options(context), binary: unlicensed }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ name: 'PreconditionFailedError', remediation: 'sudo fm license' });
    expect(fs.existsSync(context.paths.probe) ? fs.readdirSync(context.paths.probe).filter((name) => name.endsWith('.json')) : []).toEqual([]);
  });
});
