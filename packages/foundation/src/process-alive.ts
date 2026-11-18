import { readFileSync } from 'node:fs';
import type { FileSystem } from './node-file-system.ts';
import { hostSignalSender } from './platform/group-port.ts';
import { isErrno } from './platform/inspector-types.ts';
import { canStillRun } from './platform/run-state.ts';

export type SignalSender = (pid: number, signal: NodeJS.Signals | 0) => void;

export type RunStateOf = (pid: number) => string | undefined;

const UNREADABLE_CODES: ReadonlySet<string | undefined> = new Set(['EACCES', 'EPERM']);

export const UNREAD_STATE = 'unread';

const GONE_READ_CODES: ReadonlySet<string | undefined> = new Set(['ENOENT', 'ESRCH']);

export const linuxRunStateOf =
  (read: (file: string) => string): RunStateOf =>
  (pid) => {
    let stat: string;
    try {
      stat = read(`/proc/${pid}/stat`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (GONE_READ_CODES.has(code)) return undefined;
      if (UNREADABLE_CODES.has(code)) return UNREAD_STATE;
      throw error;
    }
    return stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[0];
  };

export const hostRunStateOf: RunStateOf | null = process.platform === 'linux' ? linuxRunStateOf((file) => readFileSync(file, 'utf8')) : null;

export const isProcessAlive = (pid: number, send: SignalSender = hostSignalSender, stateOf: RunStateOf | null = send === hostSignalSender ? hostRunStateOf : null): boolean => {
  try {
    send(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code !== 'EPERM') throw error;
  }
  if (stateOf === null || pid <= 0) return true;
  const state = stateOf(pid);
  return state !== undefined && (state === UNREAD_STATE || canStillRun(state));
};

export const PID_NAMESPACE_LINK = '/proc/self/ns/pid';

export const SINGLE_PID_SPACE = 'single';

export const pidNamespaceOf = async (files: Pick<FileSystem, 'readlink'>): Promise<string> => {
  try {
    return await files.readlink(PID_NAMESPACE_LINK);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return SINGLE_PID_SPACE;
    throw error;
  }
};

export type NamedReader = { readonly pid: number; readonly namespace: string };

export type ReaderProbe = { kind: 'alive' } | { kind: 'gone' } | { kind: 'elsewhere'; namespace: string };

export const probeReader = (reader: NamedReader, namespace: string, alive: (pid: number) => boolean): ReaderProbe => {
  if (reader.namespace !== namespace) return { kind: 'elsewhere', namespace: reader.namespace };
  return alive(reader.pid) ? { kind: 'alive' } : { kind: 'gone' };
};
