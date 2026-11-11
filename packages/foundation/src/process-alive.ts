import type { FileSystem } from './node-file-system.ts';
import { hostSignalSender } from './platform/group-port.ts';
import { isErrno } from './platform/inspector-types.ts';

export type SignalSender = (pid: number, signal: NodeJS.Signals | 0) => void;

export const isProcessAlive = (pid: number, send: SignalSender = hostSignalSender): boolean => {
  try {
    send(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
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
