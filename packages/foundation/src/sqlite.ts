import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256Hex } from './canonical-json.ts';
import { OPEN_FLAGS, nodeDescriptorWriterSync, nodeFileSystemSync } from './node-file-system.ts';
import type { FileSystemSync } from './node-file-system.ts';
import { modeIsPrivate } from './platform/privacy.ts';

export const BUSY_WAIT_LIMIT_MS = 5000;

export const busyTimeoutMs = (heartbeatMs: number): number => Math.min(BUSY_WAIT_LIMIT_MS, Math.floor(heartbeatMs));

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export type OpenDatabaseOptions = { busyTimeoutMs: number; createDirectory?: boolean };

type DatabaseFiles = Pick<FileSystemSync, 'statSync' | 'openDescriptorSync' | 'closeSync' | 'mkdirSync'>;

const files: DatabaseFiles = nodeFileSystemSync;

const CREATE_NEW_FLAGS = OPEN_FLAGS.writeOnly | OPEN_FLAGS.create | OPEN_FLAGS.exclusive;

export type Migration = { version: number; name: string; sql: string; rebuildsReferencedTable?: true };

export type MigrateResult = { applied: number[]; unknownApplied: number[] };

const formatMode = (mode: number): string => (mode & 0o777).toString(8).padStart(4, '0');

const assertPrivateDirectory = (dir: string): void => {
  let stat: ReturnType<DatabaseFiles['statSync']>;
  try {
    stat = files.statSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`database directory ${dir} does not exist; create it with: mkdir -m 700 ${dir}`, { cause: error });
    }
    throw error;
  }
  if (!stat.isDirectory()) throw new Error(`database directory ${dir} is not a directory`);
  if (!modeIsPrivate(stat, 'directory')) {
    throw new Error(`database directory ${dir} has mode ${formatMode(stat.mode)} but must be 0700; run: chmod 700 ${dir}`);
  }
};

const ensurePrivateFile = (file: string): void => {
  let fd: number;
  try {
    fd = files.openDescriptorSync(file, CREATE_NEW_FLAGS, PRIVATE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const stat = files.statSync(file);
    if (!modeIsPrivate(stat, 'file')) {
      throw new Error(`database file ${file} has mode ${formatMode(stat.mode)} but must be 0600; run: chmod 600 ${file}`, { cause: error });
    }
    return;
  }
  try {
    nodeDescriptorWriterSync.chmod(fd, PRIVATE_FILE_MODE);
  } finally {
    files.closeSync(fd);
  }
};

export const openDatabase = (file: string, options: OpenDatabaseOptions): DatabaseSync => {
  const busyWaitMs = options.busyTimeoutMs;
  if (!Number.isInteger(busyWaitMs) || busyWaitMs < 0) {
    throw new RangeError(`openDatabase: busyTimeoutMs must be a non-negative integer, got ${busyWaitMs}`);
  }
  if (options.createDirectory === true) files.mkdirSync(path.dirname(file), PRIVATE_DIRECTORY_MODE);
  assertPrivateDirectory(path.dirname(file));
  ensurePrivateFile(file);
  const db = new DatabaseSync(file, { timeout: busyWaitMs, enableForeignKeyConstraints: true });
  try {
    const journal = db.prepare('PRAGMA journal_mode = WAL').get();
    if (journal?.['journal_mode'] !== 'wal') {
      throw new Error(`database ${file} could not enable WAL journal mode (got ${String(journal?.['journal_mode'])})`);
    }
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
};

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as { then?: unknown }).then === 'function';

const rollback = (db: DatabaseSync, cause: unknown): never => {
  if (db.isTransaction) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError([cause, rollbackError], 'transaction failed and ROLLBACK also failed');
    }
  }
  throw cause;
};

export const immediateTx = <T>(db: DatabaseSync, fn: () => T): T => {
  if (db.isTransaction) throw new Error('immediateTx cannot be nested: a transaction is already open on this connection');
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    if (isPromiseLike(result)) throw new TypeError('immediateTx callback must be synchronous; it returned a Promise');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    return rollback(db, error);
  }
};

export const joinedTx = <T>(db: DatabaseSync, fn: () => T): T => (db.isTransaction ? fn() : immediateTx(db, fn));

const pinReadSnapshot = (db: DatabaseSync): void => {
  db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
};

export const readTx = <T>(db: DatabaseSync, fn: () => T): T => {
  if (db.isTransaction) throw new Error('readTx cannot be nested: a transaction is already open on this connection');
  db.exec('BEGIN');
  try {
    pinReadSnapshot(db);
    const result = fn();
    if (isPromiseLike(result)) throw new TypeError('readTx callback must be synchronous; it returned a Promise');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    return rollback(db, error);
  }
};

type AppliedRow = { version: number; name: string; checksum: string };

const readApplied = (db: DatabaseSync): AppliedRow[] =>
  db
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => {
      const { version, name, checksum } = row;
      if (typeof version !== 'number' || typeof name !== 'string' || typeof checksum !== 'string') {
        throw new Error(`schema_migrations contains a malformed row: ${JSON.stringify(row)}`);
      }
      return { version, name, checksum };
    });

const checksumMismatch = (version: number, name: string): Error =>
  new Error(
    `migration version ${version} (${name}) was applied with different SQL than this build contains; ` +
      'the database was created by a different build, so refusing to continue',
  );

const validateMigrations = (migrations: readonly Migration[]): Migration[] => {
  const sorted = [...migrations].sort((left, right) => left.version - right.version);
  sorted.forEach((migration, index) => {
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new Error(`migration "${migration.name}" has invalid version ${migration.version}; versions are integers from 1`);
    }
    const previous = sorted[index - 1];
    if (previous !== undefined && previous.version === migration.version) {
      throw new Error(`duplicate migration version ${migration.version} ("${previous.name}" and "${migration.name}")`);
    }
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new Error(`migration gap: expected version ${expected} but found ${migration.version} ("${migration.name}")`);
    }
  });
  return sorted;
};

const readerFloorOf = (db: DatabaseSync): { minReader: number; release: string } | undefined => {
  const table = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'store_compat'").get();
  if (table === undefined) return undefined;
  const row = db.prepare('SELECT min_reader, min_reader_release FROM store_compat WHERE id = 1').get();
  if (row === undefined) return undefined;
  const { min_reader: minReader, min_reader_release: release } = row;
  if (typeof minReader !== 'number' || typeof release !== 'string') throw new Error(`store_compat contains a malformed row: ${JSON.stringify(row)}`);
  return { minReader, release };
};

const assertReaderFloor = (db: DatabaseSync, highestKnown: number): void => {
  const floor = readerFloorOf(db);
  if (floor !== undefined && highestKnown < floor.minReader) {
    throw new Error(`this database needs momonga v${floor.release} or newer; update or restart this CLI`);
  }
};

export const highestAppliedMigration = (db: DatabaseSync): number => {
  const row = db.prepare('SELECT MAX(version) AS highest FROM schema_migrations').get();
  const highest = row?.['highest'];
  if (highest === null) return 0;
  if (typeof highest !== 'number') throw new Error(`schema_migrations has a malformed version: ${JSON.stringify(row)}`);
  return highest;
};

export const migrate = (db: DatabaseSync, migrations: readonly Migration[]): MigrateResult => {
  const sorted = validateMigrations(migrations);
  immediateTx(db, () => {
    db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL)',
    );
  });
  const known = new Map(sorted.map((migration) => [migration.version, migration]));
  assertReaderFloor(db, sorted.at(-1)?.version ?? 0);
  const unknownApplied: number[] = [];
  for (const row of readApplied(db)) {
    const migration = known.get(row.version);
    if (migration === undefined) {
      unknownApplied.push(row.version);
      continue;
    }
    if (row.checksum !== sha256Hex(migration.sql)) throw checksumMismatch(row.version, row.name);
  }
  const applied: number[] = [];
  const selectChecksum = db.prepare('SELECT checksum FROM schema_migrations WHERE version = ?');
  const insert = db.prepare('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)');
  for (const migration of sorted) {
    const rebuilds = migration.rebuildsReferencedTable === true;
    if (rebuilds) db.exec('PRAGMA foreign_keys = OFF');
    try {
      if (applyMigration(db, migration, selectChecksum, insert, rebuilds)) applied.push(migration.version);
    } finally {
      if (rebuilds) db.exec('PRAGMA foreign_keys = ON');
    }
  }
  return { applied, unknownApplied };
};

const applyMigration = (
  db: DatabaseSync,
  migration: Migration,
  selectChecksum: ReturnType<DatabaseSync['prepare']>,
  insert: ReturnType<DatabaseSync['prepare']>,
  rebuilds: boolean,
): boolean => {
  const checksum = sha256Hex(migration.sql);
  return immediateTx(db, () => {
    const existing = selectChecksum.get(migration.version);
    if (existing !== undefined) {
      if (existing['checksum'] !== checksum) throw checksumMismatch(migration.version, migration.name);
      return false;
    }
    try {
      db.exec(migration.sql);
    } catch (error) {
      throw new Error(`migration version ${migration.version} (${migration.name}) failed: ${(error as Error).message}`, { cause: error });
    }
    if (rebuilds) assertNoForeignKeyViolation(db, migration);
    insert.run(migration.version, migration.name, checksum);
    return true;
  });
};

const assertNoForeignKeyViolation = (db: DatabaseSync, migration: Migration): void => {
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0) throw new Error(`migration version ${migration.version} (${migration.name}) left ${violations.length} foreign key violations`);
};
