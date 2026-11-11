import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProcessLockHeldError, acquireProcessLock, createKeyedSerializer, inspectProcessLock, withFileLock } from '@momonga/foundation';
import type { FileLockPorts } from '@momonga/foundation';
import { registerCleanup, withTempDir, sleepDrivenTiming, createFakeRandom } from '@momonga/testkit';

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
      { ports: steppedPorts(), timeoutMs: 100 },
    );
    await expect(failure).rejects.toBeInstanceOf(ProcessLockHeldError);
    expect(runs).toBe(1);
  });

  it('releases the lock after the task fails', async (context) => {
    const lockPath = path.join(withTempDir(context), 'task.lock');
    await expect(withFileLock(lockPath, () => Promise.reject(new Error('boom')), { ports: steppedPorts() })).rejects.toThrow('boom');
    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'free' });
  });

  it('gives up after the timeout, naming the lock and its holder', async (context) => {
    const lockPath = path.join(withTempDir(context), 'task.lock');
    const held = await acquireProcessLock(lockPath);
    registerCleanup(context, () => held.release());
    let runs = 0;
    const failure = withFileLock(
      lockPath,
      async () => {
        runs += 1;
      },
      { ports: steppedPorts(), timeoutMs: 50 },
    );
    await expect(failure).rejects.toThrow(/timed out after 50ms/);
    await expect(failure).rejects.toThrow(lockPath);
    await expect(failure).rejects.toThrow(String(process.pid));
    expect(runs).toBe(0);
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
