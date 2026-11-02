import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { LOCK_DATABASE_SUFFIX, createSqliteFileLock, nodeSqliteLockOps, sqliteFileLock } from '@momonga/foundation';
import type { SqliteLockOps } from '@momonga/foundation';
import { registerCleanup, startLockHolder, withTempDir } from '@momonga/testkit';

const SOURCE = path.resolve(import.meta.dirname, '..', 'src', 'platform', 'sqlite-lock.ts');

const claimOrThrow = async (lockPath: string) => {
  const outcome = await sqliteFileLock.claim(lockPath);
  if (outcome.kind !== 'claimed') throw new Error('the lock was not free');
  return outcome.lock;
};

describe('a held lock of the Linux and Windows mechanism, polled from its own process', () => {
  it('still excludes another process after one contended claim in the holding process', async (context) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    const lock = await claimOrThrow(lockPath);
    registerCleanup(context, () => lock.release());

    expect((await sqliteFileLock.claim(lockPath)).kind).toBe('held');

    await expect(startLockHolder(context, lockPath, 'linux')).rejects.toThrow(/exited \(code 1/);
  });

  it('refuses a symlink in place of its database, whether or not the lock has been claimed before', async (context) => {
    const dir = withTempDir(context);
    const lockPath = path.join(dir, 'runtime.lock');
    const target = path.join(dir, 'elsewhere');
    fs.writeFileSync(target, '');
    fs.symlinkSync(target, `${lockPath}${LOCK_DATABASE_SUFFIX}`);

    await expect(sqliteFileLock.claim(lockPath)).rejects.toThrow();
  });
});

describe('a database that goes away between opening it and locking it', () => {
  const claimWithInterference = async (context: Parameters<typeof withTempDir>[0], interfere: (databasePath: string) => void) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    const databasePath = `${lockPath}${LOCK_DATABASE_SUFFIX}`;
    fs.writeFileSync(databasePath, '');
    const opened: DatabaseSync[] = [];
    const mechanism = createSqliteFileLock({
      ...nodeSqliteLockOps,
      open: (target) => {
        const database = nodeSqliteLockOps.open(target);
        opened.push(database);
        if (opened.length === 1) interfere(target);
        return database;
      },
    });
    const outcome = await mechanism.claim(lockPath);
    if (outcome.kind !== 'claimed') throw new Error('the lock was not free');
    registerCleanup(context, () => outcome.lock.release());
    return { opened, databasePath };
  };

  it('does not keep a lock on a database that was replaced, and claims the one the path names now', async (context) => {
    const { opened, databasePath } = await claimWithInterference(context, (target) => {
      fs.writeFileSync(`${target}.replacement`, '');
      fs.renameSync(`${target}.replacement`, target);
    });

    expect(opened).toHaveLength(2);
    expect(opened[0]?.isOpen).toBe(false);
    expect(opened[1]?.isOpen).toBe(true);
    expect(fs.existsSync(databasePath)).toBe(true);
  });

  it('does not keep a lock on a database that was removed, and creates the one the path names now', async (context) => {
    const { opened, databasePath } = await claimWithInterference(context, (target) => fs.unlinkSync(target));

    expect(opened).toHaveLength(2);
    expect(opened[0]?.isOpen).toBe(false);
    expect(fs.existsSync(databasePath)).toBe(true);
  });
});

describe('a database that another claimant creates and removes during the claim', () => {
  it('retries instead of throwing when the file is gone again right after it was created', async (context) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    let lookups = 0;
    const mechanism = createSqliteFileLock({
      ...nodeSqliteLockOps,
      lstat: (target) => {
        lookups += 1;
        return lookups <= 2 ? undefined : nodeSqliteLockOps.lstat(target);
      },
    });

    const outcome = await mechanism.claim(lockPath);
    if (outcome.kind !== 'claimed') throw new Error('the lock was not free');
    registerCleanup(context, () => outcome.lock.release());

    expect(lookups).toBeGreaterThan(2);
  });
});

describe('disposing a lock on a platform that cannot remove an open file', () => {
  const disposeWith = async (context: Parameters<typeof withTempDir>[0], failure: NodeJS.ErrnoException | undefined) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    const databasePath = `${lockPath}${LOCK_DATABASE_SUFFIX}`;
    const events: string[] = [];
    let database: DatabaseSync | undefined;
    const ops: SqliteLockOps = {
      ...nodeSqliteLockOps,
      removesOpenFiles: false,
      open: (target) => {
        database = nodeSqliteLockOps.open(target);
        return database;
      },
      remove: (file) => {
        events.push(`${path.basename(file)} while ${database?.isOpen === true ? 'open' : 'closed'}`);
        if (file === databasePath && failure !== undefined) throw failure;
        nodeSqliteLockOps.remove(file);
      },
    };
    const outcome = await createSqliteFileLock(ops).claim(lockPath);
    if (outcome.kind !== 'claimed') throw new Error('the lock was not free');
    outcome.lock.writeHolder('1');
    return { dispose: () => outcome.lock.dispose(), events };
  };

  it('removes the holder record while the lock is held and the database after it is closed', async (context) => {
    const { dispose, events } = await disposeWith(context, undefined);

    dispose();

    expect(events).toEqual(['runtime.lock while open', 'runtime.lock.sqlite while closed']);
  });

  it('treats a database that is still in use as a successor holding it, and leaves it', async (context) => {
    const inUse = Object.assign(new Error('busy'), { code: 'EBUSY' });
    const { dispose } = await disposeWith(context, inUse);

    expect(() => dispose()).not.toThrow();
  });

  it('keeps any other removal failure', async (context) => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const { dispose } = await disposeWith(context, denied);

    expect(() => dispose()).toThrow(denied);
  });
});

describe('the source of the Linux and Windows mechanism', () => {
  it('carries no comment', () => {
    expect(fs.readFileSync(SOURCE, 'utf8')).not.toMatch(/^\s*(\/\/|\/\*)/m);
  });
});
