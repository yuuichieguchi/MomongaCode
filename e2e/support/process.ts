import fs from 'node:fs';
import { groupAlive, isProcessAlive } from '@momonga/foundation';
import { until } from './wait.ts';

export type LivenessPorts = {
  processRunning(pid: number): boolean;
  groupRunning(pgid: number): Promise<boolean>;
};

export const hostLiveness: LivenessPorts = {
  processRunning: (pid) => isProcessAlive(pid),
  groupRunning: (pgid) => groupAlive(pgid),
};

export const processRunning = (pid: number, ports: LivenessPorts = hostLiveness): boolean => ports.processRunning(pid);

export const groupRunning = (pgid: number, ports: LivenessPorts = hostLiveness): Promise<boolean> => ports.groupRunning(pgid);

export const groupSignalable = (pgid: number): boolean => isProcessAlive(-pgid);

export type Ended = { readonly group?: number; readonly processes?: readonly number[] };

export const expectEndedAtTerminal = async (status: string, ended: Ended, ports: LivenessPorts = hostLiveness): Promise<void> => {
  const still = [
    ...(ended.group !== undefined && (await ports.groupRunning(ended.group)) ? [`group ${ended.group}`] : []),
    ...(ended.processes ?? []).filter((pid) => ports.processRunning(pid)).map((pid) => `process ${pid}`),
  ];
  if (still.length > 0) throw new Error(`status ${status} is visible, so the product has ended these and confirmed them gone, but ${still.join(', ')} can still run`);
};

export const untilProcessesEnded = async (pids: readonly number[], options: { deadlineMs: number; description: string }, ports: LivenessPorts = hostLiveness): Promise<void> => {
  await until(() => pids.every((pid) => !ports.processRunning(pid)), options);
};

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
