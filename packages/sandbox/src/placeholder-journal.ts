import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Awaitable, PlaceholderForm } from '@momonga/foundation';

export type PlaceholderIdentity = { device: string; inode: string };

export type PlaceholderRecord = { path: string; intentMs: number; form: PlaceholderForm; identity: PlaceholderIdentity | null };

export type PlaceholderJournal = {
  intend(target: string, intentMs: number, form?: PlaceholderForm): Promise<void>;
  complete(target: string, identity: PlaceholderIdentity): Promise<void>;
  forget(target: string): Promise<void>;
  records(): Promise<PlaceholderRecord[]>;
};

export type RecoveryPorts = { holders: () => Awaitable<ReadonlySet<string>> };

export type RecoveryResult = { removed: string[]; kept: string[]; unrecovered: string[] };

export type ProcPort = { list(directory: string): Awaitable<string[]>; read(file: string): Awaitable<string> };

const JOURNAL_FILE_MODE = 0o600;
const JOURNAL_DIRECTORY_MODE = 0o700;
const RECORD_SUFFIX = '.json';
const OCTAL_ESCAPE = /\\([0-7]{3})/g;
const PROCESS_DIRECTORY = /^\d+$/;
const MOUNT_POINT_FIELD = 4;
const VANISHED = new Set(['ENOENT', 'ESRCH', 'EINVAL']);
const NOT_OURS = new Set(['EACCES', 'EPERM']);

export const EMPTY_FILE_FORM: PlaceholderForm = { kind: 'file', bytes: '' };

const isAbsent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

const lstatOrAbsent = async (target: string): Promise<fs.BigIntStats | undefined> => {
  try {
    return await fs.promises.lstat(target, { bigint: true });
  } catch (error) {
    if (isAbsent(error)) return undefined;
    throw error;
  }
};

export const identityOf = async (target: string): Promise<PlaceholderIdentity> => {
  const stat = await fs.promises.lstat(target, { bigint: true });
  return { device: String(stat.dev), inode: String(stat.ino) };
};

const hasForm = async (target: string, stat: fs.BigIntStats, form: PlaceholderForm): Promise<boolean> => {
  if (form.kind === 'directory') return stat.isDirectory() && (await fs.promises.readdir(target)).length === 0;
  const bytes = Buffer.from(form.bytes, 'latin1');
  return stat.isFile() && stat.size === BigInt(bytes.length) && (await fs.promises.readFile(target)).equals(bytes);
};

export const isStillThePlaceholder = async (target: string, identity: PlaceholderIdentity, form: PlaceholderForm = EMPTY_FILE_FORM): Promise<boolean> => {
  const stat = await lstatOrAbsent(target);
  if (stat === undefined || !(await hasForm(target, stat, form))) return false;
  return String(stat.dev) === identity.device && String(stat.ino) === identity.inode;
};

export const removePlaceholderEntry = async (target: string, form: PlaceholderForm): Promise<void> => {
  if (form.kind === 'directory') await fs.promises.rmdir(target);
  else await fs.promises.unlink(target);
};

const fileNameOf = (target: string): string => `${createHash('sha256').update(target).digest('hex').slice(0, 32)}${RECORD_SUFFIX}`;

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await fs.promises.open(directory, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
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
  let made: Promise<void> | undefined;
  const ready = (): Promise<void> => {
    made ??= fs.promises.mkdir(directory, { recursive: true, mode: JOURNAL_DIRECTORY_MODE }).then(() => undefined);
    return made;
  };
  const fileOf = (target: string): string => path.join(directory, fileNameOf(target));
  const write = async (record: PlaceholderRecord): Promise<void> => {
    await ready();
    const file = fileOf(record.path);
    const temporary = `${file}.${process.pid}.tmp`;
    const handle = await fs.promises.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, JOURNAL_FILE_MODE);
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(temporary, file);
    await syncDirectory(directory);
  };
  const readRecord = async (file: string): Promise<PlaceholderRecord | undefined> => {
    try {
      return parseRecord(file, await fs.promises.readFile(file, 'utf8'));
    } catch (error) {
      if (isAbsent(error)) return undefined;
      throw error;
    }
  };
  return {
    intend: (target, intentMs, form = EMPTY_FILE_FORM) => write({ path: target, intentMs, form, identity: null }),
    complete: async (target, identity) => {
      const record = await readRecord(fileOf(target));
      if (record === undefined) throw new Error(`the placeholder journal has no intent for ${target}`);
      await write({ ...record, identity });
    },
    forget: async (target) => {
      await ready();
      await fs.promises.rm(fileOf(target), { force: true });
      await syncDirectory(directory);
    },
    records: async () => {
      await ready();
      const names = (await fs.promises.readdir(directory)).filter((name) => name.endsWith(RECORD_SUFFIX));
      const records: PlaceholderRecord[] = [];
      for (const name of names) records.push(parseRecord(name, await fs.promises.readFile(path.join(directory, name), 'utf8')));
      return records.sort((left, right) => (left.path < right.path ? -1 : 1));
    },
  };
};

const mountPointsOf = (mountinfo: string): string[] =>
  mountinfo
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => (line.split(' ')[MOUNT_POINT_FIELD] as string).replace(OCTAL_ESCAPE, (_escape, code: string) => String.fromCharCode(Number.parseInt(code, 8))));

const nodeProcPort: ProcPort = { list: (directory) => fs.promises.readdir(directory), read: (file) => fs.promises.readFile(file, 'utf8') };

type Read = { kind: 'text'; text: string } | { kind: 'gone' } | { kind: 'not-ours' };

const readMountinfo = async (port: ProcPort, file: string): Promise<Read> => {
  try {
    return { kind: 'text', text: await port.read(file) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (VANISHED.has(code)) return { kind: 'gone' };
    if (NOT_OURS.has(code)) return { kind: 'not-ours' };
    throw error;
  }
};

const threadsOf = async (port: ProcPort, pid: string): Promise<string[]> => {
  try {
    return await port.list(`/proc/${pid}/task`);
  } catch (error) {
    if (VANISHED.has((error as NodeJS.ErrnoException).code ?? '')) return [];
    throw error;
  }
};

export const heldMountPoints = async (port: ProcPort = nodeProcPort): Promise<ReadonlySet<string>> => {
  const held = new Set<string>();
  for (const entry of (await port.list('/proc')).filter((name) => PROCESS_DIRECTORY.test(name))) {
    const leader = await readMountinfo(port, `/proc/${entry}/mountinfo`);
    const reads: Read[] = [];
    if (leader.kind === 'gone') for (const tid of await threadsOf(port, entry)) reads.push(await readMountinfo(port, `/proc/${entry}/task/${tid}/mountinfo`));
    else reads.push(leader);
    for (const read of reads) if (read.kind === 'text') for (const mountPoint of mountPointsOf(read.text)) held.add(mountPoint);
  }
  return held;
};

const NODE_RECOVERY_PORTS: RecoveryPorts = { holders: () => heldMountPoints() };

export const recoverPlaceholders = async (journal: PlaceholderJournal, ports: RecoveryPorts = NODE_RECOVERY_PORTS): Promise<RecoveryResult> => {
  const result: RecoveryResult = { removed: [], kept: [], unrecovered: [] };
  const records = await journal.records();
  if (records.length === 0) return result;
  const holders = await ports.holders();
  for (const record of records) {
    if (record.identity === null) {
      if ((await lstatOrAbsent(record.path)) !== undefined) result.unrecovered.push(record.path);
      else await journal.forget(record.path);
      continue;
    }
    if (!(await isStillThePlaceholder(record.path, record.identity, record.form))) {
      await journal.forget(record.path);
      continue;
    }
    if (holders.has(record.path)) {
      result.kept.push(record.path);
      continue;
    }
    await removePlaceholderEntry(record.path, record.form);
    await journal.forget(record.path);
    result.removed.push(record.path);
  }
  return result;
};
