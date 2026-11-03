import { describe, expect, it } from 'vitest';
import { acquireProcessLock, ensureMomongaDirs, inspectProcessLock, isProcessAlive, momongaPaths } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, registerCleanup, startLockHolder, stopSupervisorHolder, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';

const preparedHome = async (context: CleanupContext): Promise<{ home: string; lockPath: string }> => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home);
  await ensureMomongaDirs(paths);
  return { home, lockPath: paths.locks.supervisor };
};

describe('stopSupervisorHolder', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('kills the process that holds the supervisor lock of a home and returns once the lock is free', async (context) => {
    const { home, lockPath } = await preparedHome(context);
    const holder = await startLockHolder(context, lockPath);

    expect(await stopSupervisorHolder(home)).toBe(holder.pid);

    expect(isProcessAlive(holder.pid)).toBe(false);
    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'free' });
  });

  it('does nothing and reports nothing when no process holds the supervisor lock', async (context) => {
    const { home } = await preparedHome(context);
    expect(await stopSupervisorHolder(home)).toBeUndefined();
  });

  it('never signals the calling process when the calling process holds the lock', async (context) => {
    const { home, lockPath } = await preparedHome(context);
    const lock = await acquireProcessLock(lockPath);
    registerCleanup(context, () => lock.release());

    expect(await stopSupervisorHolder(home)).toBeUndefined();

    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'held', pid: process.pid });
  });
});
