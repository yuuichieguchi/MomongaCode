import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LockWaitTimeoutError, ProcessLockHeldError, acquireProcessLock, createKeyedSerializer, inspectProcessLock, withFileLock } from '@momonga/foundation';
import type { FileLockPorts } from '@momonga/foundation';
import { DEFAULT_LOCK_TIMEOUT_MS } from '../src/file-lock.ts';
import { registerCleanup, withTempDir, sleepDrivenTiming, createFakeRandom, testKernelLock } from '@momonga/testkit';

const NEVER_ABORTED = new AbortController().signal;

const steppedPorts = (): FileLockPorts => {
  let now = 1_000_000;
  return {
    timing: sleepDrivenTiming({
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    }),
    random: { ...createFakeRandom(1), hex: () => 'deadbeef' },
  };
};

describe('withFileLock', () => {
  it('runs the task once when the task itself raises a held-lock error', async (context) => {
    const lockPath = path.join(withTempDir(context), 'task.lock');
    let runs = 0;
    const failure = withFileLock(
      lockPath,
      async () => {
        runs += 1;
        throw new ProcessLockHeldError('held by someone else', '/elsewhere.lock', 4242);
      },
      { mechanism: testKernelLock(), ports: steppedPorts(), timeoutMs: 100 },
    );
    await expect(failure).rejects.toBeInstanceOf(ProcessLockHeldError);
    expect(runs).toBe(1);
  });

  it('releases the lock after the task fails', async (context) => {
    const lockPath = path.join(withTempDir(context), 'task.lock');
    await expect(withFileLock(lockPath, () => Promise.reject(new Error('boom')), { mechanism: testKernelLock(), ports: steppedPorts() })).rejects.toThrow('boom');
    expect(await inspectProcessLock(lockPath, { mechanism: testKernelLock() })).toEqual({ state: 'free' });
  });

  it('gives up after the timeout, naming the lock and its holder', async (context) => {
    const lockPath = path.join(withTempDir(context), 'task.lock');
    const held = await acquireProcessLock(lockPath, undefined, { mechanism: testKernelLock() });
    registerCleanup(context, () => held.release());
    let runs = 0;
    const failure = withFileLock(
      lockPath,
      async () => {
        runs += 1;
      },
      { mechanism: testKernelLock(), ports: steppedPorts(), timeoutMs: 50 },
    );
    await expect(failure).rejects.toThrow(/timed out after 50ms/);
    await expect(failure).rejects.toThrow(lockPath);
    await expect(failure).rejects.toThrow(String(process.pid));
    expect(runs).toBe(0);
  });

  it('the timeout rejects with LockWaitTimeoutError, which carries the lock, the bound and the holder (A5)', async (context) => {
    const lockPath = path.join(withTempDir(context), 'task.lock');
    const held = await acquireProcessLock(lockPath, undefined, { mechanism: testKernelLock() });
    registerCleanup(context, () => held.release());
    const failure = await withFileLock(lockPath, async () => undefined, { mechanism: testKernelLock(), ports: steppedPorts(), timeoutMs: 50, signal: NEVER_ABORTED }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LockWaitTimeoutError);
    expect(failure).toMatchObject({ name: 'LockWaitTimeoutError', lockPath, timeoutMs: 50, holder: String(process.pid) });
    expect((failure as Error).message).toBe(`timed out after 50ms waiting for lock ${lockPath} held by process ${process.pid}`);
  });

  it('a wait ended by the asker\'s signal rejects with that signal\'s reason, not with the timeout class', async (context) => {
    const lockPath = path.join(withTempDir(context), 'task.lock');
    const held = await acquireProcessLock(lockPath, undefined, { mechanism: testKernelLock() });
    registerCleanup(context, () => held.release());
    const asker = new AbortController();
    const reason = new Error('the operation ended');
    let now = 1_000_000;
    const failure = withFileLock(lockPath, async () => undefined, {
      mechanism: testKernelLock(),
      ports: {
        ...steppedPorts(),
        timing: sleepDrivenTiming({
          now: () => now,
          sleep: async (ms) => {
            now += ms;
            asker.abort(reason);
          },
        }),
      },
      signal: asker.signal,
    });
    await expect(failure).rejects.toBe(reason);
  });

  it('a wait with no signal and no timeout ends at the default lock timeout', async (context) => {
    const lockPath = path.join(withTempDir(context), 'task.lock');
    const held = await acquireProcessLock(lockPath, undefined, { mechanism: testKernelLock() });
    registerCleanup(context, () => held.release());
    let now = 1_000_000;
    const start = now;
    const failure = await withFileLock(lockPath, async () => undefined, {
      mechanism: testKernelLock(),
      ports: {
        ...steppedPorts(),
        timing: sleepDrivenTiming({
          now: () => now,
          sleep: async (ms) => {
            now += ms;
            await Promise.resolve();
            if (now - start > 10 * DEFAULT_LOCK_TIMEOUT_MS) throw new Error('the wait did not end at the default bound');
          },
        }),
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LockWaitTimeoutError);
    expect(failure).toMatchObject({ timeoutMs: DEFAULT_LOCK_TIMEOUT_MS });
    expect(now - start).toBe(DEFAULT_LOCK_TIMEOUT_MS);
  });

  it('a wait with a signal and no timeout outlasts the default lock timeout and ends only on the signal', async (context) => {
    const lockPath = path.join(withTempDir(context), 'task.lock');
    const held = await acquireProcessLock(lockPath, undefined, { mechanism: testKernelLock() });
    registerCleanup(context, () => held.release());
    let now = 1_000_000;
    const start = now;
    const controller = new AbortController();
    const reason = new Error('the operation limit');
    const failure = await withFileLock(lockPath, async () => undefined, {
      mechanism: testKernelLock(),
      ports: {
        ...steppedPorts(),
        timing: sleepDrivenTiming({
          now: () => now,
          sleep: async (ms) => {
            now += ms;
            if (now - start > 3 * DEFAULT_LOCK_TIMEOUT_MS) controller.abort(reason);
            await new Promise<void>((resolve) => setImmediate(resolve));
          },
        }),
      },
      signal: controller.signal,
    }).catch((error: unknown) => error);
    expect(failure).toBe(reason);
    expect(now - start).toBeGreaterThan(3 * DEFAULT_LOCK_TIMEOUT_MS);
  });
});

describe('createKeyedSerializer', () => {
  it('runs tasks of one key in order and keeps running after a failure', async () => {
    const serialize = createKeyedSerializer();
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    const first = serialize('k', async () => {
      await gate.promise;
      order.push('first');
      throw new Error('first failed');
    }, NEVER_ABORTED);
    const second = serialize('k', async () => {
      order.push('second');
    }, NEVER_ABORTED);
    gate.resolve();
    await expect(first).rejects.toThrow('first failed');
    await second;
    expect(order).toEqual(['first', 'second']);
  });

  it('does not make different keys wait for each other', async () => {
    const serialize = createKeyedSerializer();
    const gate = Promise.withResolvers<void>();
    const blocked = serialize('a', () => gate.promise, NEVER_ABORTED);
    await serialize('b', async () => undefined, NEVER_ABORTED);
    gate.resolve();
    await blocked;
  });
});
