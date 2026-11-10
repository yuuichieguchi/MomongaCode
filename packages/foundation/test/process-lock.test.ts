import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ProcessLockHeldError, acquireProcessLock, hostKernelLock, inspectProcessLock, isProcessAlive, listenUnix } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, registerCleanup, withTempDir, realProcessTestSignal } from '@momonga/testkit';
import { exitOf, startHolder } from './support/lock-processes.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const FILE_LOCK = hostKernelLock().name === 'file-lock';

const deadPid = async (): Promise<number> => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('spawn failed');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return pid;
};

describe('acquireProcessLock', () => {
  it('records the current pid as the holder', async (context) => {
    const lockPath = path.join(withTempDir(context), 'gateway.lock');
    const lock = await acquireProcessLock(lockPath);
    registerCleanup(context, () => lock.release());
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'held', pid: process.pid });
  });

  it('can be acquired again after release', async (context) => {
    const lockPath = path.join(withTempDir(context), 'gateway.lock');
    (await acquireProcessLock(lockPath)).release();
    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'free' });
    const again = await acquireProcessLock(lockPath);
    registerCleanup(context, () => again.release());
    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'held', pid: process.pid });
  });

  it('releasing twice releases once', async (context) => {
    const lockPath = path.join(withTempDir(context), 'gateway.lock');
    const lock = await acquireProcessLock(lockPath);
    lock.release();
    lock.release();
    const again = await acquireProcessLock(lockPath);
    registerCleanup(context, () => again.release());
  });

  it('refuses a second acquisition by the same live process', async (context) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    const lock = await acquireProcessLock(lockPath);
    registerCleanup(context, () => lock.release());
    await expect(acquireProcessLock(lockPath)).rejects.toThrow(String(process.pid));
  });

  it('throws without waiting when another process holds the lock, naming its pid', async (context) => {
    const lockPath = path.join(withTempDir(context), 'gateway.lock');
    const holder = await startHolder(context, lockPath);
    await expect(acquireProcessLock(lockPath)).rejects.toThrow(String(holder.pid));
    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'held', pid: holder.pid });
  });

  it('is free the moment a SIGKILLed holder is gone, with no stale state to recover', async (context) => {
    const lockPath = path.join(withTempDir(context), 'gateway.lock');
    const holder = await startHolder(context, lockPath);
    holder.kill('SIGKILL');
    expect(await exitOf(holder)).toEqual({ code: null, signal: 'SIGKILL' });
    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'free' });
    const lock = await acquireProcessLock(lockPath);
    registerCleanup(context, () => lock.release());
    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'held', pid: process.pid });
  });

  it('ignores a pid left in the file by a dead holder', async (context) => {
    const lockPath = path.join(withTempDir(context), 'gateway.lock');
    fs.writeFileSync(lockPath, String(await deadPid()), { mode: 0o600 });
    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'free' });
    const lock = await acquireProcessLock(lockPath);
    registerCleanup(context, () => lock.release());
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
  });

  it.skipIf(!FILE_LOCK)('keeps the lock file in place on release so that no second inode can ever be locked beside it', async (context) => {
    const lockPath = path.join(withTempDir(context), 'gateway.lock');
    (await acquireProcessLock(lockPath)).release();
    const inode = fs.statSync(lockPath).ino;
    const lock = await acquireProcessLock(lockPath);
    registerCleanup(context, () => lock.release());
    expect(fs.statSync(lockPath).ino).toBe(inode);
  });

  it.skipIf(!FILE_LOCK)('refuses to follow a symbolic link at the lock path', async (context) => {
    const dir = withTempDir(context);
    const target = path.join(dir, 'elsewhere');
    fs.writeFileSync(target, '');
    const lockPath = path.join(dir, 'gateway.lock');
    fs.symlinkSync(target, lockPath);
    await expect(acquireProcessLock(lockPath)).rejects.toMatchObject({ code: 'ELOOP' });
  });
});

describe('inspectProcessLock', () => {
  it('reports a missing lock as free without creating it', async (context) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'free' });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('reports a held lock whose holder has not recorded its pid as unreadable, never as free', async (context) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    const mechanism = hostKernelLock();
    const outcome = await mechanism.claim(lockPath);
    if (outcome.kind !== 'claimed') throw new Error('the lock was not free');
    registerCleanup(context, () => outcome.lock.release());
    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'unreadable' });
  });

  it('treats an over-long holder record as unreadable', async (context) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    const mechanism = hostKernelLock();
    const outcome = await mechanism.claim(lockPath);
    if (outcome.kind !== 'claimed') throw new Error('the lock was not free');
    registerCleanup(context, () => outcome.lock.release());
    outcome.lock.writeHolder(`${'7'.repeat(10_000)}`);
    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'unreadable' });
  });
});

describe('ProcessLockHeldError', () => {
  it('carries holderPid and lockPath and the holder description as the message', async (context) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    const holder = await startHolder(context, lockPath);
    const failure = await acquireProcessLock(lockPath, async (pid) => `held by ${pid} for test`).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProcessLockHeldError);
    expect((failure as ProcessLockHeldError).holderPid).toBe(holder.pid);
    expect((failure as ProcessLockHeldError).lockPath).toBe(lockPath);
    expect((failure as ProcessLockHeldError).message).toBe(`held by ${holder.pid} for test`);
  });

  it('uses the default holder description as the message', async (context) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    const holder = await startHolder(context, lockPath);
    const failure = await acquireProcessLock(lockPath).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((failure as Error).message).toBe(`${lockPath} is held by live process ${holder.pid}`);
  });

  it('listenUnix surfaces ProcessLockHeldError', async (context) => {
    const dir = withTempDir(context);
    const socketPath = path.join(dir, 'r.sock');
    const holder = await startHolder(context, `${socketPath}.lock`);
    const server = net.createServer();
    registerCleanup(context, () => void server.close());
    const failure = await listenUnix(server, socketPath, undefined, realProcessTestSignal()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProcessLockHeldError);
    expect((failure as ProcessLockHeldError).holderPid).toBe(holder.pid);
    expect((failure as ProcessLockHeldError).lockPath).toBe(`${socketPath}.lock`);
    expect((failure as Error).message).toBe(`${socketPath} is already in use by process ${holder.pid} (lock ${socketPath}.lock)`);
  });
});

describe('isProcessAlive', () => {
  it('reports the current process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('reports an exited process as dead', async () => {
    expect(isProcessAlive(await deadPid())).toBe(false);
  });

  it('treats EPERM as alive', () => {
    expect(isProcessAlive(1)).toBe(true);
  });

  it('rethrows errors other than ESRCH and EPERM', () => {
    expect(() => isProcessAlive(Number.NaN)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
  });
});
