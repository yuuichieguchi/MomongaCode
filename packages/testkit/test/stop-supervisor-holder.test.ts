import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION, acquireProcessLock, ensureGenerationDirs, ensureMomongaDirs, generationLayout, inspectProcessLock, isProcessAlive, momongaPaths } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, firstGeneration, registerCleanup, startLockHolder, stopSupervisorHolders, withTempDir, testKernelLock } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const preparedHome = async (context: CleanupContext): Promise<{ home: string; lockPath: string }> => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home);
  await ensureMomongaDirs(paths);
  await ensureGenerationDirs(paths, FIRST_GENERATION);
  return { home, lockPath: firstGeneration(paths).locks.supervisor };
};

describe('stopSupervisorHolders', () => {
  it('kills the process that holds the supervisor lock of a home and returns once the lock is free', async (context) => {
    const { home, lockPath } = await preparedHome(context);
    const holder = await startLockHolder(context, lockPath);

    expect(await stopSupervisorHolders(home)).toEqual([holder.pid]);

    expect(isProcessAlive(holder.pid)).toBe(false);
    expect(await inspectProcessLock(lockPath, { mechanism: testKernelLock() })).toEqual({ state: 'free' });
  });

  it('kills the holder of the supervisor lock of every generation of a home (20.78)', async (context) => {
    const { home, lockPath } = await preparedHome(context);
    const second = generationLayout(home, 2);
    await ensureGenerationDirs(momongaPaths(home), 2);
    const holders = [await startLockHolder(context, lockPath), await startLockHolder(context, second.locks.supervisor)];

    expect(await stopSupervisorHolders(home)).toEqual(holders.map((holder) => holder.pid));

    for (const holder of holders) expect(isProcessAlive(holder.pid)).toBe(false);
    expect(await inspectProcessLock(second.locks.supervisor, { mechanism: testKernelLock() })).toEqual({ state: 'free' });
  });

  it('does nothing and reports nothing when no process holds a supervisor lock', async (context) => {
    const { home } = await preparedHome(context);
    expect(await stopSupervisorHolders(home)).toEqual([]);
  });

  it('never signals the calling process when the calling process holds the lock', async (context) => {
    const { home, lockPath } = await preparedHome(context);
    const lock = await acquireProcessLock(lockPath, undefined, { mechanism: testKernelLock() });
    registerCleanup(context, () => lock.release());

    expect(await stopSupervisorHolders(home)).toEqual([]);

    expect(await inspectProcessLock(lockPath, { mechanism: testKernelLock() })).toEqual({ state: 'held', pid: process.pid });
  });
});
