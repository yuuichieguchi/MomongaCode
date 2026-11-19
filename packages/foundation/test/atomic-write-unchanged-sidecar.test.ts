import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeFileSystem, systemRandom, writeFileAtomically } from '@momonga/foundation';
import type { AtomicWriteFileSystem } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { LOCK_DATABASE_SUFFIX, createSqliteFileLock, nodeSqliteLockOps } from '../src/platform/sqlite-lock.ts';
import type { SqliteLockOps } from '../src/platform/sqlite-lock.ts';

const refusedRename: AtomicWriteFileSystem = {
  ...nodeFileSystem,
  rename: async () => {
    throw Object.assign(new Error('the disk refused the rename'), { code: 'EIO' });
  },
};

const writeReportingUnchanged = async (ops: SqliteLockOps, fs: AtomicWriteFileSystem, file: string): Promise<boolean> => {
  let unchanged = false;
  await expect(
    writeFileAtomically(fs, systemRandom, file, 'x', {
      mode: 0o644,
      lock: createSqliteFileLock(ops),
      onFailedUnchanged: () => {
        unchanged = true;
      },
    }),
  ).rejects.toThrow();
  return unchanged;
};

const lockDatabasesIn = (folder: string): string[] => fs.readdirSync(folder).filter((name) => name.includes(LOCK_DATABASE_SUFFIX));

describe('a failed atomic write under the sidecar lock reports the workspace unchanged only when its lock file is gone', () => {
  it('a failed write whose lock file was removed is reported unchanged', async (context) => {
    const folder = withTempDir(context);
    expect(await writeReportingUnchanged(nodeSqliteLockOps, refusedRename, path.join(folder, 'new.txt'))).toBe(true);
    expect(fs.readdirSync(folder)).toEqual([]);
  });

  it('a failed write whose lock file could not be removed is not reported unchanged', async (context) => {
    const folder = withTempDir(context);
    const inUse: SqliteLockOps = {
      ...nodeSqliteLockOps,
      removesOpenFiles: false,
      remove: (file) => {
        if (file.endsWith(LOCK_DATABASE_SUFFIX)) throw Object.assign(new Error('the file is in use'), { code: 'EBUSY' });
        nodeSqliteLockOps.remove(file);
      },
    };
    expect(await writeReportingUnchanged(inUse, refusedRename, path.join(folder, 'new.txt'))).toBe(false);
    expect(lockDatabasesIn(folder)).toHaveLength(1);
  });

  it('a sidecar claim that fails after creating its lock file is not reported unchanged', async (context) => {
    const folder = withTempDir(context);
    const failingOpen: SqliteLockOps = {
      ...nodeSqliteLockOps,
      open: () => {
        throw Object.assign(new Error('the lock database could not be opened'), { code: 'EIO' });
      },
    };
    expect(await writeReportingUnchanged(failingOpen, nodeFileSystem, path.join(folder, 'new.txt'))).toBe(false);
    expect(lockDatabasesIn(folder)).toHaveLength(1);
  });
});
