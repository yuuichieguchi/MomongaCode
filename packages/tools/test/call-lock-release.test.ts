import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostKernelLock, sqliteFileLock } from '@momonga/foundation';
import type { ReapTiming } from '@momonga/foundation';
import { registerCleanup, startLockHolder, withTempDir } from '@momonga/testkit';
import { createCallLocks } from '../src/call-lock.ts';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import type { Harness } from './harness.ts';
import { deferred, keyFor } from './helpers.ts';

const KEY = keyFor('run-1', 1, 'c1');
const READ_AND_ENTER_ONLY = 0o500;
const PRIVATE_DIR = 0o700;

const advancingTiming = (): ReapTiming => {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
  };
};

const never = (): AbortSignal => new AbortController().signal;

const acquired = async <T>(lock: Promise<T | 'aborted'>): Promise<T> => {
  const held = await lock;
  if (held === 'aborted') throw new Error('the lock was aborted');
  return held;
};

const lockPathOf = (harness: Harness): string => path.join(harness.callLockDir, `${KEY}.lock`);

const seal = (dir: string, context: Parameters<typeof registerCleanup>[0]): void => {
  fs.chmodSync(dir, READ_AND_ENTER_ONLY);
  registerCleanup(context, () => fs.chmodSync(dir, PRIVATE_DIR));
};

describe('call lock files of the Linux and Windows mechanism', () => {
  it('leaves nothing behind after release', async (context) => {
    const dir = withTempDir(context);
    const locks = createCallLocks({ dir, mechanism: sqliteFileLock, timing: advancingTiming(), waitMs: 0 });

    const lock = await acquired(locks.acquire('a', never()));
    lock.release();

    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('leaves nothing behind after many calls, one key each', async (context) => {
    const dir = withTempDir(context);
    const locks = createCallLocks({ dir, mechanism: sqliteFileLock, timing: advancingTiming(), waitMs: 0 });

    for (const key of ['a', 'b', 'c']) (await acquired(locks.acquire(key, never()))).release();

    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('excludes another process while the same process polls the held call', async (context) => {
    const dir = withTempDir(context);
    const locks = createCallLocks({ dir, mechanism: sqliteFileLock, timing: advancingTiming(), waitMs: 25 });
    const lock = await acquired(locks.acquire('a', never()));
    registerCleanup(context, () => lock.release());

    await expect(locks.acquire('a', never())).rejects.toMatchObject({ code: 'earlier_attempt_not_stopped' });

    await expect(startLockHolder(context, path.join(dir, 'a.lock'), 'linux')).rejects.toThrow(/exited \(code 1/);
  });
});

describe('a call lock whose file cannot be removed', () => {
  it('still drops the kernel lock and keeps the removal error', async (context) => {
    const dir = withTempDir(context);
    const mechanism = hostKernelLock();
    const lock = await acquired(createCallLocks({ dir, mechanism, timing: advancingTiming(), waitMs: 0 }).acquire('a', never()));
    seal(dir, context);

    expect(() => lock.release()).toThrow(expect.objectContaining({ code: 'EACCES' }));

    expect(await mechanism.isHeld(path.join(dir, 'a.lock'))).toBe(false);
  });

  it('keeps the outcome of the call, frees the lock and reports the failure instead of leaving a rejection unhandled', async (context) => {
    const warned = deferred<string>();
    const unhandled = deferred<string>();
    const onUnhandled = (): void => unhandled.resolve('unhandled');
    process.once('unhandledRejection', onUnhandled);
    registerCleanup(context, () => {
      process.off('unhandledRejection', onUnhandled);
    });
    const harness = makeHarness({ executor: { onWarning: (message: string) => warned.resolve(message) } });
    const tool = makeTool('Write', {
      kind: 'edit',
      sideEffect: 'write', subjectKind: 'none',
      execute: async () => {
        fs.chmodSync(harness.callLockDir, READ_AND_ENTER_ONLY);
        return { status: 'completed', output: 'ran' };
      },
    });

    const outcomes = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Write', {}, 'allow_once')]));
    const reported = await Promise.race([warned.promise, unhandled.promise]);
    fs.chmodSync(harness.callLockDir, PRIVATE_DIR);

    expect(outcomes[0]).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'ran' } });
    expect(reported).toContain('EACCES');
    expect(harness.kernelLock.isHeldBy(lockPathOf(harness))).toBeUndefined();
    expect(harness.executor.inFlightKeys().size).toBe(0);
  });

  it('keeps the outcome, frees the lock and finishes the bookkeeping when the process marker cannot be removed', async () => {
    const warned = deferred<string>();
    const harness = makeHarness({ executor: { onWarning: (message: string) => warned.resolve(message) } });
    const tool = makeTool('Bash', {
      kind: 'execute',
      sideEffect: 'exec', subjectKind: 'none',
      execute: async () => {
        fs.chmodSync(harness.markerDir, READ_AND_ENTER_ONLY);
        return { status: 'completed', output: 'ran' };
      },
    });

    const outcomes = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Bash', {}, 'allow_once')]));
    fs.chmodSync(harness.markerDir, PRIVATE_DIR);

    expect(outcomes[0]).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'ran' } });
    expect(await warned.promise).toContain('EACCES');
    expect(harness.kernelLock.isHeldBy(lockPathOf(harness))).toBeUndefined();
    expect(harness.executor.inFlightKeys().size).toBe(0);
  });

  it('keeps the outcome of a reconciled call that started no effect, frees the lock, finishes the bookkeeping and reports the failure', async () => {
    const warned = deferred<string>();
    const harness = makeHarness({ executor: { onWarning: (message: string) => warned.resolve(message) } });
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit' });
    const tool = makeTool('Edit', {
      kind: 'edit',
      sideEffect: 'write', subjectKind: 'none',
      reconcile: async () => {
        fs.chmodSync(harness.callLockDir, READ_AND_ENTER_ONLY);
        return { outcome: 'already_applied', output: 'reconciled' };
      },
    });

    const outcomes = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Edit', {}, 'allow_once')]));
    fs.chmodSync(harness.callLockDir, PRIVATE_DIR);

    expect(outcomes[0]).toMatchObject({ kind: 'result', reconciled: 'already_applied' });
    expect(await warned.promise).toContain('EACCES');
    expect(harness.kernelLock.isHeldBy(lockPathOf(harness))).toBeUndefined();
    expect(harness.executor.inFlightKeys().size).toBe(0);
  });
});
