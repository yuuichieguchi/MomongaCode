import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { ClaimOutcome, HeldKernelLock, KernelLockMechanism } from './kernel-lock.ts';
import { readHolderFile, readHolderFileSync, writeHolderFile } from './holder-file.ts';
import { noFollowFlag } from './privacy.ts';

export const LOCK_DATABASE_SUFFIX = '.sqlite';

const SQLITE_BUSY = 5;
const SQLITE_RESULT_CODE_MASK = 0xff;

const isBusy = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'errcode' in error && typeof error.errcode === 'number' && (error.errcode & SQLITE_RESULT_CODE_MASK) === SQLITE_BUSY;

const databasePathOf = (lockPath: string): string => `${lockPath}${LOCK_DATABASE_SUFFIX}`;

const openForClaim = (databasePath: string): DatabaseSync => {
  fs.closeSync(fs.openSync(databasePath, fs.constants.O_RDWR | fs.constants.O_CREAT | noFollowFlag(), 0o600));
  return new DatabaseSync(databasePath, { timeout: 0 });
};

const readLockAcquirable = (database: DatabaseSync): boolean => {
  try {
    database.exec('BEGIN');
    database.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
    return true;
  } catch (error) {
    if (isBusy(error)) return false;
    throw error;
  } finally {
    if (database.isTransaction) database.exec('ROLLBACK');
  }
};

const claimDatabase = (lockPath: string): ClaimOutcome => {
  const database = openForClaim(databasePathOf(lockPath));
  try {
    for (;;) {
      try {
        database.exec('BEGIN EXCLUSIVE');
        break;
      } catch (error) {
        if (!isBusy(error)) throw error;
        if (!readLockAcquirable(database)) {
          database.close();
          return { kind: 'held' };
        }
      }
    }
  } catch (error) {
    if (database.isOpen) database.close();
    throw error;
  }
  let open = true;
  const lock: HeldKernelLock = {
    descriptor: undefined,
    writeHolder: (text) => writeHolderFile(lockPath, text),
    release: () => {
      if (!open) return;
      open = false;
      database.close();
    },
  };
  return { kind: 'claimed', lock };
};

const probeDatabase = (lockPath: string): boolean => {
  try {
    fs.lstatSync(databasePathOf(lockPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const database = new DatabaseSync(databasePathOf(lockPath), { timeout: 0 });
  try {
    return !readLockAcquirable(database);
  } finally {
    database.close();
  }
};

export const sqliteFileLock: KernelLockMechanism = {
  name: 'sqlite-lock',
  claim: async (lockPath) => claimDatabase(lockPath),
  isHeld: async (lockPath) => probeDatabase(lockPath),
  readHolder: readHolderFile,
  readHolderSync: readHolderFileSync,
  claimInheritable: undefined,
  adoptInherited: undefined,
};
