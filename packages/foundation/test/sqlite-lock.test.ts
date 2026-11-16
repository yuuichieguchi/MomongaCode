import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LOCK_DATABASE_SUFFIX, ProcessLockHeldError, acquireProcessLock, inspectProcessLock, kernelLockNamed, sqliteFileLock } from '@momonga/foundation';
import { resolveKernelLock } from '../src/platform/kernel-lock.ts';
import { REAL_PROCESS_TEST_TIMEOUT_MS, registerCleanup, startLockHolder, withTempDir, fixedLockCapability } from '@momonga/testkit';
import { exitOf } from './support/lock-processes.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const claimOrThrow = async (lockPath: string) => {
  const outcome = await sqliteFileLock.claim(lockPath);
  if (outcome.kind !== 'claimed') throw new Error('the lock was not free');
  return outcome.lock;
};

describe('the lock of a directory that does not enforce BSD locks', () => {
  it('is one file-based mechanism, not an address in a namespace shared by other users or scoped to a network namespace', () => {
    expect(resolveKernelLock('/unused', { capability: fixedLockCapability('unenforced') })).toBe(sqliteFileLock);
    expect(resolveKernelLock('/unused', { capability: fixedLockCapability('unmeasured') })).toBe(sqliteFileLock);
    expect(kernelLockNamed('sqlite-lock')).toBe(sqliteFileLock);
    expect(sqliteFileLock.name).toBe('sqlite-lock');
  });

  it('keeps its state in a private file beside the lock path, so reaching it needs access to the user directory', async (context) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    const lock = await claimOrThrow(lockPath);
    registerCleanup(context, () => lock.release());
    const databaseFile = `${lockPath}${LOCK_DATABASE_SUFFIX}`;
    expect(fs.statSync(databaseFile).mode & 0o777).toBe(0o600);
  });

  it('claims once, reports a second claim from the same process as held, and is free again after release', async (context) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    const first = await claimOrThrow(lockPath);
    expect(await sqliteFileLock.isHeld(lockPath)).toBe(true);
    expect((await sqliteFileLock.claim(lockPath)).kind).toBe('held');
    first.writeHolder('4242');
    expect(await sqliteFileLock.readHolder(lockPath)).toBe('4242');
    first.release();
    first.release();
    expect(await sqliteFileLock.isHeld(lockPath)).toBe(false);
    const again = await claimOrThrow(lockPath);
    registerCleanup(context, () => again.release());
  });

  it('reports the same lock reached through another path as held', async (context) => {
    const dir = withTempDir(context);
    const alias = path.join(dir, 'alias');
    fs.mkdirSync(path.join(dir, 'real'));
    fs.symlinkSync(path.join(dir, 'real'), alias);
    const lock = await claimOrThrow(path.join(dir, 'real', 'runtime.lock'));
    registerCleanup(context, () => lock.release());
    expect((await sqliteFileLock.claim(path.join(alias, 'runtime.lock'))).kind).toBe('held');
  });

  it('reports a lock that was never claimed as free without creating anything', async (context) => {
    const dir = withTempDir(context);
    expect(await sqliteFileLock.isHeld(path.join(dir, 'runtime.lock'))).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('does not map a claim it cannot make to held', async (context) => {
    const dir = withTempDir(context);
    await expect(sqliteFileLock.claim(path.join(dir, 'missing', 'runtime.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cannot be handed to a child process', () => {
    expect(sqliteFileLock.claimInheritable).toBeUndefined();
    expect(sqliteFileLock.adoptInherited).toBeUndefined();
  });
});

describe('the lock of a directory entry', () => {
  it('is disposed without removing the directory, which is not a file the claim owns', async (context) => {
    const entry = path.join(withTempDir(context), 'entry-directory');
    fs.mkdirSync(entry);
    const lock = await claimOrThrow(entry);
    expect(() => lock.dispose?.()).not.toThrow();
    expect(fs.statSync(entry).isDirectory()).toBe(true);
  });
});

describe('the lock used on Linux and Windows, held by another process', () => {
  it('is held and names the holder while the process lives, and is free the moment a killed holder is gone', async (context) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    const holder = await startLockHolder(context, lockPath, 'sqlite-lock');
    expect(await inspectProcessLock(lockPath, { mechanism: sqliteFileLock })).toEqual({ state: 'held', pid: holder.pid });
    const failure = await acquireProcessLock(lockPath, undefined, { mechanism: sqliteFileLock }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProcessLockHeldError);
    expect((failure as ProcessLockHeldError).holderPid).toBe(holder.pid);
    holder.kill('SIGKILL');
    expect(await exitOf(holder)).toEqual({ code: null, signal: 'SIGKILL' });
    expect(await inspectProcessLock(lockPath, { mechanism: sqliteFileLock })).toEqual({ state: 'free' });
    const lock = await claimOrThrow(lockPath);
    registerCleanup(context, () => lock.release());
  });
});
