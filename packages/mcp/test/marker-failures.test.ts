import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MCP_MODERN_SERVER_PATH, MODERN_FIXTURE_SETSID_GRANDCHILD_ENV, REAL_PROCESS_TEST_TIMEOUT_MS, killPidsForCleanup } from '@momonga/testkit';
import { createTransport, eventually, makeDir, onCleanup, pidAlive, rawConfig, trackPid } from './raw-transport.ts';

const control = vi.hoisted(() => ({
  failPidWriteUnder: undefined as string | undefined,
  reapFailure: undefined as Error | undefined,
  reapCalls: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  const writeFileSync = ((file: fs.PathOrFileDescriptor, data: unknown, options?: fs.WriteFileOptions) => {
    if (control.failPidWriteUnder !== undefined && typeof file === 'string' && file.startsWith(control.failPidWriteUnder) && /^\d+\n$/.test(String(data))) {
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    }
    return original.writeFileSync(file, data as string, options);
  }) as typeof original.writeFileSync;
  return { ...original, writeFileSync, default: { ...original, writeFileSync } };
});

vi.mock('@momonga/foundation', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/foundation')>();
  return {
    ...original,
    reapMarkedProcesses: async (...args: Parameters<typeof original.reapMarkedProcesses>) => {
      control.reapCalls += 1;
      if (control.reapFailure !== undefined) throw control.reapFailure;
      return original.reapMarkedProcesses(...args);
    },
  };
});

const PROCESS_TIMEOUT = { timeout: REAL_PROCESS_TEST_TIMEOUT_MS };

const markerSetup = () => {
  const dir = path.join(makeDir(), 'markers');
  fs.mkdirSync(dir, { mode: 0o700 });
  return { dir, markers: { dir, onWarning: () => undefined } };
};

describe('MCP marker failure handling', () => {
  it('keeps the marker when the pid write fails after spawn, and close still sweeps a setsid grandchild', PROCESS_TIMEOUT, async () => {
    const { dir, markers } = markerSetup();
    const readyFile = path.join(makeDir(), 'setsid.pid');
    onCleanup(() => {
      if (!fs.existsSync(readyFile)) return;
      const pid = Number(fs.readFileSync(readyFile, 'utf8'));
      if (pid > 1 && pidAlive(pid)) killPidsForCleanup([pid]);
    });
    control.failPidWriteUnder = dir;
    control.reapFailure = undefined;
    const transport = createTransport({
      config: { command: process.execPath, args: [MCP_MODERN_SERVER_PATH], env: { [MODERN_FIXTURE_SETSID_GRANDCHILD_ENV]: readyFile } },
      markers,
      closeGraceMs: 200,
    });

    try {
      await expect(transport.start()).rejects.toThrow(/ENOSPC/);
    } finally {
      control.failPidWriteUnder = undefined;
    }

    expect(fs.readdirSync(dir)).toHaveLength(1);
    await eventually(() => fs.existsSync(readyFile), 'the setsid grandchild to start');
    const grandchild = Number(fs.readFileSync(readyFile, 'utf8'));
    trackPid(grandchild);
    expect(fs.readdirSync(dir)).toHaveLength(1);

    await transport.close().catch(() => undefined);

    expect(pidAlive(grandchild)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  const failingClose = async (options: { terminateFails: boolean; sweepFails: boolean }) => {
    const { markers } = markerSetup();
    const terminateFailure = new Error('terminate failed');
    const sweepFailure = new Error('sweep failed');
    let terminateCalls = 0;
    const transport = createTransport({
      config: rawConfig(),
      markers,
      closeGraceMs: 200,
      ...(options.terminateFails
        ? {
            terminate: async () => {
              terminateCalls += 1;
              throw terminateFailure;
            },
          }
        : {}),
    });
    await transport.start();
    control.reapCalls = 0;
    control.reapFailure = options.sweepFails ? sweepFailure : undefined;
    let outcome: unknown;
    try {
      await transport.close();
      outcome = 'resolved';
    } catch (error) {
      outcome = error;
    } finally {
      control.reapFailure = undefined;
    }
    return { outcome, terminateFailure, sweepFailure, terminateCalls: () => terminateCalls };
  };

  it('when terminate fails and the marker sweep fails too, close rejects with an AggregateError holding both, terminate first', PROCESS_TIMEOUT, async () => {
    const { outcome, terminateFailure, sweepFailure, terminateCalls } = await failingClose({ terminateFails: true, sweepFails: true });

    expect(outcome).toBeInstanceOf(AggregateError);
    expect((outcome as AggregateError).errors).toEqual([terminateFailure, sweepFailure]);
    expect((outcome as AggregateError).errors[0]).toBe(terminateFailure);
    expect((outcome as AggregateError).errors[1]).toBe(sweepFailure);
    expect(terminateCalls()).toBe(1);
    expect(control.reapCalls).toBe(1);
  });

  it('when only terminate fails, close rethrows the terminate error as is after the sweep ran', PROCESS_TIMEOUT, async () => {
    const { outcome, terminateFailure } = await failingClose({ terminateFails: true, sweepFails: false });

    expect(outcome).toBe(terminateFailure);
    expect(control.reapCalls).toBe(1);
  });

  it('when only the marker sweep fails, close rethrows the sweep error as is', PROCESS_TIMEOUT, async () => {
    const { outcome, sweepFailure } = await failingClose({ terminateFails: false, sweepFails: true });

    expect(outcome).toBe(sweepFailure);
    expect(control.reapCalls).toBe(1);
  });
});
