import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCK_DATABASE_SUFFIX, ProcessLockHeldError, acquireProcessLock, createKernelLockMechanism, inspectProcessLock, sqliteFileLock } from '@momonga/foundation';
import { registerCleanup, startLockHolder, withTempDir } from '@momonga/testkit';
import { exitOf } from './support/lock-processes.ts';

const claimOrThrow = async (lockPath: string) => {
  const outcome = await sqliteFileLock.claim(lockPath);
  if (outcome.kind !== 'claimed') throw new Error('the lock was not free');
  return outcome.lock;
};

describe('the lock used on Linux and Windows', () => {
  it('is one file-based mechanism for both platforms, not an address in a namespace shared by other users or scoped to a network namespace', () => {
    expect(createKernelLockMechanism('linux')).toBe(sqliteFileLock);
    expect(createKernelLockMechanism('win32')).toBe(sqliteFileLock);
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

describe('the lock used on Linux and Windows, held by another process', () => {
  it('is held and names the holder while the process lives, and is free the moment a killed holder is gone', async (context) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    const holder = await startLockHolder(context, lockPath, 'linux');
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
