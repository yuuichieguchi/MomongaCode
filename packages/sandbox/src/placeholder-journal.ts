import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type PlaceholderIdentity = { device: string; inode: string };

export type PlaceholderRecord = PlaceholderIdentity & { path: string };

export type PlaceholderJournal = {
  record(record: PlaceholderRecord): void;
  forget(target: string): void;
  records(): PlaceholderRecord[];
};

export type RecoveryPorts = { holders: () => ReadonlySet<string> };

export type RecoveryResult = { removed: string[]; kept: string[] };

const JOURNAL_FILE_MODE = 0o600;
const JOURNAL_DIRECTORY_MODE = 0o700;
const RECORD_SUFFIX = '.json';
const OCTAL_ESCAPE = /\\([0-7]{3})/g;
const PROCESS_DIRECTORY = /^\d+$/;
const MOUNT_POINT_FIELD = 4;
const VANISHED = new Set(['ENOENT', 'ESRCH', 'EINVAL']);
const NOT_OURS = new Set(['EACCES', 'EPERM']);

export const identityOf = (target: string): PlaceholderIdentity => {
  const stat = fs.lstatSync(target, { bigint: true });
  return { device: String(stat.dev), inode: String(stat.ino) };
};

const fileNameOf = (target: string): string => `${createHash('sha256').update(target).digest('hex').slice(0, 32)}${RECORD_SUFFIX}`;

const syncDirectory = (directory: string): void => {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

const parseRecord = (file: string, text: string): PlaceholderRecord => {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null) throw new Error(`the placeholder record ${file} is not an object`);
  const { path: target, device, inode } = value as Record<string, unknown>;
  if (typeof target !== 'string' || typeof device !== 'string' || typeof inode !== 'string') {
    throw new Error(`the placeholder record ${file} lacks a path, a device or an inode`);
  }
  return { path: target, device, inode };
};

export const createPlaceholderJournal = (directory: string): PlaceholderJournal => {
  fs.mkdirSync(directory, { recursive: true, mode: JOURNAL_DIRECTORY_MODE });
  return {
    record: (record) => {
      const file = path.join(directory, fileNameOf(record.path));
      const temporary = `${file}.${process.pid}.tmp`;
      const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, JOURNAL_FILE_MODE);
      try {
        fs.writeFileSync(descriptor, JSON.stringify(record));
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, file);
      syncDirectory(directory);
    },
    forget: (target) => {
      fs.rmSync(path.join(directory, fileNameOf(target)), { force: true });
      syncDirectory(directory);
    },
    records: () =>
      fs
        .readdirSync(directory)
        .filter((name) => name.endsWith(RECORD_SUFFIX))
        .map((name) => parseRecord(name, fs.readFileSync(path.join(directory, name), 'utf8')))
        .sort((left, right) => (left.path < right.path ? -1 : 1)),
  };
};

const mountPointsOf = (mountinfo: string): string[] =>
  mountinfo
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => (line.split(' ')[MOUNT_POINT_FIELD] as string).replace(OCTAL_ESCAPE, (_escape, code: string) => String.fromCharCode(Number.parseInt(code, 8))));

export const heldMountPoints = (): ReadonlySet<string> => {
  const held = new Set<string>();
  for (const entry of fs.readdirSync('/proc').filter((name) => PROCESS_DIRECTORY.test(name))) {
    let mountinfo: string;
    try {
      mountinfo = fs.readFileSync(`/proc/${entry}/mountinfo`, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (VANISHED.has(code) || NOT_OURS.has(code)) continue;
      throw error;
    }
    for (const mountPoint of mountPointsOf(mountinfo)) held.add(mountPoint);
  }
  return held;
};

const NODE_RECOVERY_PORTS: RecoveryPorts = { holders: heldMountPoints };

const isStillThePlaceholder = (record: PlaceholderRecord): boolean => {
  const stat = fs.lstatSync(record.path, { bigint: true, throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile() || stat.size !== 0n) return false;
  return String(stat.dev) === record.device && String(stat.ino) === record.inode;
};

export const recoverPlaceholders = (journal: PlaceholderJournal, ports: RecoveryPorts = NODE_RECOVERY_PORTS): RecoveryResult => {
  const result: RecoveryResult = { removed: [], kept: [] };
  const records = journal.records();
  if (records.length === 0) return result;
  const holders = ports.holders();
  for (const record of records) {
    if (!isStillThePlaceholder(record)) {
      journal.forget(record.path);
      continue;
    }
    if (holders.has(record.path)) {
      result.kept.push(record.path);
      continue;
    }
    fs.unlinkSync(record.path);
    journal.forget(record.path);
    result.removed.push(record.path);
  }
  return result;
};
