import os from 'node:os';
import { failureOfError, isErrno, probeFailed } from './inspector-types.ts';
import type { ProbeFailure, ProbeResult, ProcessInspector } from './inspector-types.ts';
import { auxvLayoutOf, isPidDirectoryName, parseBootTimeSeconds, parseClockTicksPerSecond, parseProcStat } from './linux-parsers.ts';
import type { AuxvLayout } from './linux-parsers.ts';
import type { FileIdentity, ProcFs } from './procfs.ts';

export type LinuxInspectorPorts = { procfs: ProcFs; uid: number; layout?: AuxvLayout };

const hostLayout = (): AuxvLayout => auxvLayoutOf(process.arch, os.endianness());

const GONE_CODES = ['ENOENT', 'ESRCH'];
const DENIED_CODES = ['EACCES', 'EPERM'];

type ClockParameters = { bootMs: number; ticksPerSecond: number };

class UnparseableProcfs extends Error {}

class Uninspectable extends Error {}

const parsed = <T>(read: () => T): T => {
  try {
    return read();
  } catch (error) {
    throw new UnparseableProcfs((error as Error).message);
  }
};

const failureOf = (error: unknown): ProbeFailure =>
  error instanceof UnparseableProcfs ? probeFailed({ kind: 'unparseable', detail: error.message }) : failureOfError(error);

export const createLinuxInspector = ({ procfs, uid, layout }: LinuxInspectorPorts): ProcessInspector => {
  let clock: ClockParameters | undefined;
  const clockParameters = async (): Promise<ClockParameters> => {
    if (clock !== undefined) return clock;
    const resolvedLayout = layout ?? hostLayout();
    const [stat, auxv] = await Promise.all([procfs.readText('/proc/stat'), procfs.readBytes('/proc/self/auxv')]);
    clock = parsed(() => ({ bootMs: parseBootTimeSeconds(stat) * 1000, ticksPerSecond: parseClockTicksPerSecond(auxv, resolvedLayout) }));
    return clock;
  };

  const statOf = async (pid: number) => {
    try {
      const text = await procfs.readText(`/proc/${pid}/stat`);
      return parsed(() => parseProcStat(text));
    } catch (error) {
      if (isErrno(error, ...GONE_CODES)) return undefined;
      throw error;
    }
  };

  const fdsOf = async (pid: number): Promise<string[]> => {
    try {
      return await procfs.list(`/proc/${pid}/fd`);
    } catch (error) {
      if (isErrno(error, ...GONE_CODES)) return [];
      if (!isErrno(error, ...DENIED_CODES)) throw error;
      let owner: number;
      try {
        owner = await procfs.ownerOf(`/proc/${pid}`);
      } catch (ownerError) {
        if (isErrno(ownerError, ...GONE_CODES)) return [];
        throw ownerError;
      }
      if (owner !== uid) return [];
      throw new Uninspectable(`process ${pid} belongs to the current user but its descriptors are not readable (${(error as Error).message})`);
    }
  };

  const identityOfFd = async (pid: number, fd: string): Promise<FileIdentity | undefined> => {
    try {
      return await procfs.identityOf(`/proc/${pid}/fd/${fd}`);
    } catch (error) {
      if (isErrno(error, ...GONE_CODES)) return undefined;
      throw error;
    }
  };

  const guarded = async <T>(read: () => Promise<ProbeResult<T>>): Promise<ProbeResult<T>> => {
    try {
      return await read();
    } catch (error) {
      if (error instanceof Uninspectable) return probeFailed({ kind: 'opaque', detail: error.message });
      return failureOf(error);
    }
  };

  return {
    startTimeOf: (pid) =>
      guarded(async () => {
        const stat = await statOf(pid);
        if (stat === undefined) return { kind: 'gone' };
        const { bootMs, ticksPerSecond } = await clockParameters();
        return { kind: 'value', value: bootMs + Number((stat.startTicks * 1000n) / BigInt(ticksPerSecond)) };
      }),
    holdersOf: (marker) =>
      guarded(async () => {
        let target: FileIdentity;
        try {
          target = await procfs.identityOf(marker);
        } catch (error) {
          if (isErrno(error, 'ENOENT')) return { kind: 'gone' };
          throw error;
        }
        const pids = (await procfs.list('/proc')).filter(isPidDirectoryName).map(Number);
        const holders: number[] = [];
        for (const pid of pids) {
          for (const fd of await fdsOf(pid)) {
            const identity = await identityOfFd(pid, fd);
            if (identity !== undefined && identity.dev === target.dev && identity.ino === target.ino) {
              holders.push(pid);
              break;
            }
          }
        }
        return { kind: 'value', value: holders };
      }),
    groupsOf: (pids) =>
      guarded(async () => {
        const groups = new Map<number, number>();
        for (const pid of pids) {
          const stat = await statOf(pid);
          if (stat !== undefined) groups.set(pid, stat.groupId);
        }
        return { kind: 'value', value: groups };
      }),
  };
};
