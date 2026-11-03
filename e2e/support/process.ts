import fs from 'node:fs';
import { groupAlive as groupAliveOf, isProcessAlive } from '@momonga/foundation';

export const isAlive = (pid: number): boolean => isProcessAlive(pid);

export const groupAlive = (pgid: number): boolean => groupAliveOf(pgid);

export type ProcView = {
  pids(): number[];
  ownPidNamespace(): string | undefined;
  pidNamespaceOf(pid: number): string | undefined;
  innermostPidOf(pid: number): number | undefined;
};

const UNREADABLE_CODES: ReadonlySet<string | undefined> = new Set(['ENOENT', 'ESRCH', 'EACCES', 'EPERM']);

export const readIfReadable =<T>(read: () => T): T | undefined => {
  try {
    return read();
  } catch (error) {
    if (UNREADABLE_CODES.has((error as NodeJS.ErrnoException).code)) return undefined;
    throw error;
  }
};

export const hostProcView: ProcView = {
  pids: () => fs.readdirSync('/proc').filter((name) => /^[1-9]\d*$/.test(name)).map(Number),
  ownPidNamespace: () => readIfReadable(() => fs.readlinkSync('/proc/self/ns/pid')),
  pidNamespaceOf: (pid) => readIfReadable(() => fs.readlinkSync(`/proc/${pid}/ns/pid`)),
  innermostPidOf: (pid) =>
    readIfReadable(() => {
      const ids = /^NSpid:\s+(.+)$/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]?.trim().split(/\s+/);
      return ids === undefined ? undefined : Number(ids.at(-1));
    }),
};

export const hostPidOf = (innerPid: number, insideMember: number, view: ProcView = hostProcView): number | undefined => {
  const own = view.ownPidNamespace();
  if (own === undefined) return innerPid;
  const namespace = view.pidNamespaceOf(insideMember);
  if (namespace === undefined) throw new Error(`process ${insideMember}, whose pid namespace names the sandbox, is gone or unreadable`);
  if (namespace === own) return innerPid;
  return view.pids().find((pid) => view.pidNamespaceOf(pid) === namespace && view.innermostPidOf(pid) === innerPid);
};
