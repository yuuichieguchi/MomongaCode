import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PlaceholderForm } from '@momonga/foundation';

export type PlaceholderIdentity = { device: string; inode: string };

export type PlaceholderRecord = { path: string; intentMs: number; form: PlaceholderForm; identity: PlaceholderIdentity | null };

export type PlaceholderJournal = {
  intend(target: string, intentMs: number, form?: PlaceholderForm): void;
  complete(target: string, identity: PlaceholderIdentity): void;
  forget(target: string): void;
  records(): PlaceholderRecord[];
};

export type RecoveryPorts = { holders: () => ReadonlySet<string> };

export type RecoveryResult = { removed: string[]; kept: string[]; unrecovered: string[] };

export type ProcPort = { list(directory: string): string[]; read(file: string): string };

const JOURNAL_FILE_MODE = 0o600;
const JOURNAL_DIRECTORY_MODE = 0o700;
const RECORD_SUFFIX = '.json';
const OCTAL_ESCAPE = /\\([0-7]{3})/g;
const PROCESS_DIRECTORY = /^\d+$/;
const MOUNT_POINT_FIELD = 4;
const VANISHED = new Set(['ENOENT', 'ESRCH', 'EINVAL']);
const NOT_OURS = new Set(['EACCES', 'EPERM']);

export const EMPTY_FILE_FORM: PlaceholderForm = { kind: 'file', bytes: '' };

export const identityOf = (target: string): PlaceholderIdentity => {
  const stat = fs.lstatSync(target, { bigint: true });
  return { device: String(stat.dev), inode: String(stat.ino) };
};

const hasForm = (target: string, stat: fs.BigIntStats, form: PlaceholderForm): boolean => {
  if (form.kind === 'directory') return stat.isDirectory() && fs.readdirSync(target).length === 0;
  const bytes = Buffer.from(form.bytes, 'latin1');
  return stat.isFile() && stat.size === BigInt(bytes.length) && fs.readFileSync(target).equals(bytes);
};

export const isStillThePlaceholder = (target: string, identity: PlaceholderIdentity, form: PlaceholderForm = EMPTY_FILE_FORM): boolean => {
  const stat = fs.lstatSync(target, { bigint: true, throwIfNoEntry: false });
  if (stat === undefined || !hasForm(target, stat, form)) return false;
  return String(stat.dev) === identity.device && String(stat.ino) === identity.inode;
};

export const removePlaceholderEntry = (target: string, form: PlaceholderForm): void => {
  if (form.kind === 'directory') fs.rmdirSync(target);
  else fs.unlinkSync(target);
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

const parseIdentity = (file: string, value: unknown): PlaceholderIdentity | null => {
  if (value === null) return null;
  const { device, inode } = (value ?? {}) as Record<string, unknown>;
  if (typeof device !== 'string' || typeof inode !== 'string') {
    throw new Error(`the placeholder record ${file} has an identity without a device or an inode`);
  }
  return { device, inode };
};

const parseForm = (file: string, value: unknown): PlaceholderForm => {
  if (value === undefined) return EMPTY_FILE_FORM;
  const { kind, bytes } = (value ?? {}) as Record<string, unknown>;
  if (kind === 'directory') return { kind: 'directory' };
  if (kind === 'file' && typeof bytes === 'string') return { kind: 'file', bytes };
  throw new Error(`the placeholder record ${file} has a form that is neither a directory nor a file with bytes`);
};

const parseRecord = (file: string, text: string): PlaceholderRecord => {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null) throw new Error(`the placeholder record ${file} is not an object`);
  const { path: target, intentMs, form, identity } = value as Record<string, unknown>;
  if (typeof target !== 'string' || typeof intentMs !== 'number') throw new Error(`the placeholder record ${file} lacks a path or an intent time`);
  return { path: target, intentMs, form: parseForm(file, form), identity: parseIdentity(file, identity ?? null) };
};

export const createPlaceholderJournal = (directory: string): PlaceholderJournal => {
  fs.mkdirSync(directory, { recursive: true, mode: JOURNAL_DIRECTORY_MODE });
  const fileOf = (target: string): string => path.join(directory, fileNameOf(target));
  const write = (record: PlaceholderRecord): void => {
    const file = fileOf(record.path);
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
  };
  return {
    intend: (target, intentMs, form = EMPTY_FILE_FORM) => write({ path: target, intentMs, form, identity: null }),
    complete: (target, identity) => {
      const file = fileOf(target);
      if (!fs.existsSync(file)) throw new Error(`the placeholder journal has no intent for ${target}`);
      write({ ...parseRecord(file, fs.readFileSync(file, 'utf8')), identity });
    },
    forget: (target) => {
      fs.rmSync(fileOf(target), { force: true });
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

const nodeProcPort: ProcPort = { list: (directory) => fs.readdirSync(directory), read: (file) => fs.readFileSync(file, 'utf8') };

type Read = { kind: 'text'; text: string } | { kind: 'gone' } | { kind: 'not-ours' };

const readMountinfo = (port: ProcPort, file: string): Read => {
  try {
    return { kind: 'text', text: port.read(file) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (VANISHED.has(code)) return { kind: 'gone' };
    if (NOT_OURS.has(code)) return { kind: 'not-ours' };
    throw error;
  }
};

const threadsOf = (port: ProcPort, pid: string): string[] => {
  try {
    return port.list(`/proc/${pid}/task`);
  } catch (error) {
    if (VANISHED.has((error as NodeJS.ErrnoException).code ?? '')) return [];
    throw error;
  }
};

export const heldMountPoints = (port: ProcPort = nodeProcPort): ReadonlySet<string> => {
  const held = new Set<string>();
  for (const entry of port.list('/proc').filter((name) => PROCESS_DIRECTORY.test(name))) {
    const leader = readMountinfo(port, `/proc/${entry}/mountinfo`);
    const reads = leader.kind === 'gone' ? threadsOf(port, entry).map((tid) => readMountinfo(port, `/proc/${entry}/task/${tid}/mountinfo`)) : [leader];
    for (const read of reads) if (read.kind === 'text') for (const mountPoint of mountPointsOf(read.text)) held.add(mountPoint);
  }
  return held;
};

const NODE_RECOVERY_PORTS: RecoveryPorts = { holders: () => heldMountPoints() };

const exists = (target: string): boolean => fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined;

export const recoverPlaceholders = (journal: PlaceholderJournal, ports: RecoveryPorts = NODE_RECOVERY_PORTS): RecoveryResult => {
  const result: RecoveryResult = { removed: [], kept: [], unrecovered: [] };
  const records = journal.records();
  if (records.length === 0) return result;
  const holders = ports.holders();
  for (const record of records) {
    if (record.identity === null) {
      if (exists(record.path)) result.unrecovered.push(record.path);
      else journal.forget(record.path);
      continue;
    }
    if (!isStillThePlaceholder(record.path, record.identity, record.form)) {
      journal.forget(record.path);
      continue;
    }
    if (holders.has(record.path)) {
      result.kept.push(record.path);
      continue;
    }
    removePlaceholderEntry(record.path, record.form);
    journal.forget(record.path);
    result.removed.push(record.path);
  }
  return result;
};
