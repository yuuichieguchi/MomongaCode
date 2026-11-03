import fs from 'node:fs';
import { groupAlive as groupAliveOf, isProcessAlive } from '@momonga/foundation';

export const isAlive = (pid: number): boolean => isProcessAlive(pid);

export const groupAlive = (pgid: number): boolean => groupAliveOf(pgid);

export type ProcView = {
  pids(): number[];
  pidNamespaceOf(pid: number): string | undefined;
  innermostPidOf(pid: number): number | undefined;
};

const readGone = <T>(read: () => T): T | undefined => {
  try {
    return read();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return undefined;
    throw error;
  }
};

export const hostProcView: ProcView = {
  pids: () => fs.readdirSync('/proc').filter((name) => /^[1-9]\d*$/.test(name)).map(Number),
  pidNamespaceOf: (pid) => readGone(() => fs.readlinkSync(`/proc/${pid}/ns/pid`)),
  innermostPidOf: (pid) =>
    readGone(() => {
      const ids = /^NSpid:\s+(.+)$/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]?.trim().split(/\s+/);
      return ids === undefined ? undefined : Number(ids.at(-1));
    }),
};

export const hostPidOf = (innerPid: number, insideMember: number, view: ProcView = hostProcView): number | undefined => {
  const own = view.pidNamespaceOf(process.pid);
  if (own === undefined) return innerPid;
  const namespace = view.pidNamespaceOf(insideMember);
  if (namespace === undefined) throw new Error(`process ${insideMember}, whose pid namespace names the sandbox, is gone`);
  if (namespace === own) return innerPid;
  return view.pids().find((pid) => view.pidNamespaceOf(pid) === namespace && view.innermostPidOf(pid) === innerPid);
};
