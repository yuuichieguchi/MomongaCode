import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ClaimOutcome, HeldKernelLock, KernelLockMechanism } from './kernel-lock.ts';
import { lstatIdentity, sameFile } from './file-identity.ts';
import type { LockFileIdentity } from './file-identity.ts';
import { readHolderFile, readHolderFileSync, writeHolderFile } from './holder-file.ts';
import { OPEN_FLAGS, nodeFileSystemSync } from '../node-file-system.ts';
import { createCapabilityProbe, unmeasuredBecause } from '../capability-probe.ts';
import type { CapabilityResult } from '../capability-probe.ts';
import { systemRandom } from '../system-random.ts';

export const LOCK_DATABASE_SUFFIX = '.sqlite';

const SQLITE_BUSY = 5;
const SQLITE_RESULT_CODE_MASK = 0xff;

const isBusy = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'errcode' in error && typeof error.errcode === 'number' && (error.errcode & SQLITE_RESULT_CODE_MASK) === SQLITE_BUSY;

const databasePathOf = (lockPath: string): string => `${lockPath}${LOCK_DATABASE_SUFFIX}`;

export type OpenLockDatabase = (databasePath: string) => DatabaseSync;

export type SqliteLockOps = {
  open: OpenLockDatabase;
  lstat(databasePath: string): LockFileIdentity | undefined;
  createIfAbsent(databasePath: string): void;
  remove(file: string): void;
  removesOpenFiles: boolean;
};

export type UnlinkOpenProbePorts = {
  createExclusive(file: string): number;
  unlink(file: string): void;
  close(descriptor: number): void;
};

const UNLINK_OPEN_REFUSED = new Set(['EBUSY', 'EPERM']);

export const probeRemovesOpenFiles = (directory: string, ports: UnlinkOpenProbePorts): CapabilityResult<boolean> => {
  const file = path.join(directory, `.momonga-unlink-probe-${process.pid}-${systemRandom.hex(6)}`);
  let descriptor: number;
  try {
    descriptor = ports.createExclusive(file);
  } catch (error) {
    return { kind: 'unmeasured', evidence: `the unlink-open probe file could not be created in ${directory}: ${unmeasuredBecause(error).evidence}` };
  }
  let outcome: CapabilityResult<boolean>;
  try {
    ports.unlink(file);
    outcome = { kind: 'supported', value: true, evidence: `${directory} lets an open file be unlinked` };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    outcome =
      code !== undefined && UNLINK_OPEN_REFUSED.has(code)
        ? { kind: 'unsupported', evidence: `${directory} refuses to unlink an open file (${code})` }
        : { kind: 'unmeasured', evidence: `unlinking an open probe file in ${directory} failed without answering the question: ${unmeasuredBecause(error).evidence}` };
  } finally {
    ports.close(descriptor);
  }
  if (outcome.kind !== 'supported') ports.unlink(file);
  return outcome;
};

const nodeUnlinkOpenPorts: UnlinkOpenProbePorts = {
  createExclusive: (file) => nodeFileSystemSync.openDescriptorSync(file, OPEN_FLAGS.readWrite | OPEN_FLAGS.create | OPEN_FLAGS.exclusive, 0o600),
  unlink: (file) => nodeFileSystemSync.unlinkSync(file),
  close: (descriptor) => nodeFileSystemSync.closeSync(descriptor),
};

const removesOpenFilesIn = createCapabilityProbe<string, boolean>(
  (directory) => directory,
  (directory) => probeRemovesOpenFiles(directory, nodeUnlinkOpenPorts),
);

const removesOpenFilesOnThisHost = (): boolean => {
  const result = removesOpenFilesIn(nodeFileSystemSync.temporaryDirectorySync());
  if (result.kind === 'unmeasured') throw new Error(`whether this host unlinks open files could not be measured: ${result.evidence}`);
  return result.kind === 'supported';
};

export const nodeSqliteLockOps: SqliteLockOps = {
  open: (databasePath) => new DatabaseSync(databasePath, { timeout: 0 }),
  lstat: lstatIdentity,
  createIfAbsent: (databasePath) => {
    try {
      nodeFileSystemSync.closeSync(nodeFileSystemSync.openDescriptorSync(databasePath, OPEN_FLAGS.readWrite | OPEN_FLAGS.create | OPEN_FLAGS.exclusive | OPEN_FLAGS.noFollow, 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  },
  remove: (file) => nodeFileSystemSync.rmSync(file),
  get removesOpenFiles(): boolean {
    return removesOpenFilesOnThisHost();
  },
};

const FILE_IN_USE = 'EBUSY';

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

const beginExclusive = (database: DatabaseSync): 'acquired' | 'held' => {
  for (;;) {
    try {
      database.exec('BEGIN EXCLUSIVE');
      return 'acquired';
    } catch (error) {
      if (!isBusy(error)) throw error;
      if (!readLockAcquirable(database)) return 'held';
    }
  }
};

const heldDatabase = (ops: SqliteLockOps, lockPath: string, databasePath: string, database: DatabaseSync): HeldKernelLock => {
  let open = true;
  let holderWritten = false;
  const release = (): void => {
    if (!open) return;
    open = false;
    database.close();
  };
  const removeDatabaseAfterClose = (): void => {
    try {
      ops.remove(databasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== FILE_IN_USE) throw error;
    }
  };
  return {
    descriptor: undefined,
    writeHolder: (text) => {
      writeHolderFile(lockPath, text);
      holderWritten = true;
    },
    release,
    dispose: () => {
      try {
        if (holderWritten) ops.remove(lockPath);
        if (ops.removesOpenFiles) ops.remove(databasePath);
      } finally {
        release();
      }
      if (!ops.removesOpenFiles) removeDatabaseAfterClose();
    },
  };
};

const claimDatabase = (ops: SqliteLockOps, lockPath: string): ClaimOutcome => {
  const databasePath = databasePathOf(lockPath);
  for (;;) {
    let identity = ops.lstat(databasePath);
    if (identity === undefined) {
      ops.createIfAbsent(databasePath);
      identity = ops.lstat(databasePath);
      if (identity === undefined) continue;
    }
    const database = ops.open(databasePath);
    try {
      if (beginExclusive(database) === 'held') {
        database.close();
        return { kind: 'held' };
      }
      if (sameFile(ops.lstat(databasePath), identity)) return { kind: 'claimed', lock: heldDatabase(ops, lockPath, databasePath, database) };
    } catch (error) {
      if (database.isOpen) database.close();
      if (sameFile(ops.lstat(databasePath), identity)) throw error;
      continue;
    }
    database.close();
  }
};

const probeDatabase = (ops: SqliteLockOps, lockPath: string): boolean => {
  const databasePath = databasePathOf(lockPath);
  if (ops.lstat(databasePath) === undefined) return false;
  const database = ops.open(databasePath);
  try {
    return !readLockAcquirable(database);
  } finally {
    database.close();
  }
};

export const createSqliteFileLock = (ops: SqliteLockOps): KernelLockMechanism => ({
  name: 'sqlite-lock',
  claim: async (lockPath) => claimDatabase(ops, lockPath),
  claimSync: (lockPath) => claimDatabase(ops, lockPath),
  isHeld: async (lockPath) => probeDatabase(ops, lockPath),
  readHolder: readHolderFile,
  readHolderSync: readHolderFileSync,
  claimInheritable: undefined,
  adoptInherited: undefined,
});

export const sqliteFileLock: KernelLockMechanism = createSqliteFileLock(nodeSqliteLockOps);
