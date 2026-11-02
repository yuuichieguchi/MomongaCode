import os from 'node:os';
import { isErrno } from './inspector-types.ts';
import type { ProcessInspector } from './inspector-types.ts';
import { auxvLayoutOf, isPidDirectoryName, parseBootTimeSeconds, parseClockTicksPerSecond, parseProcStat } from './linux-parsers.ts';
import type { AuxvLayout } from './linux-parsers.ts';
import type { FileIdentity, ProcFs } from './procfs.ts';

export type LinuxInspectorPorts = { procfs: ProcFs; layout?: AuxvLayout };

const hostLayout = (): AuxvLayout => auxvLayoutOf(process.arch, os.endianness());

const GONE_CODES = ['ENOENT', 'ESRCH'];
const FOREIGN_CODES = ['EACCES', 'EPERM'];

export const createLinuxInspector = ({ procfs, layout }: LinuxInspectorPorts): ProcessInspector => {
  let clock: Promise<{ bootMs: number; ticksPerSecond: number }> | undefined;
  const clockParameters = (): Promise<{ bootMs: number; ticksPerSecond: number }> => {
    clock ??= (async () => {
      const resolvedLayout = layout ?? hostLayout();
      const [stat, auxv] = await Promise.all([procfs.readText('/proc/stat'), procfs.readBytes('/proc/self/auxv')]);
      return { bootMs: parseBootTimeSeconds(stat) * 1000, ticksPerSecond: parseClockTicksPerSecond(auxv, resolvedLayout) };
    })();
    return clock;
  };

  const statOf = async (pid: number) => {
    try {
      return parseProcStat(await procfs.readText(`/proc/${pid}/stat`));
    } catch (error) {
      if (isErrno(error, ...GONE_CODES)) return undefined;
      throw error;
    }
  };

  const listFds = async (pid: number): Promise<string[]> => {
    try {
      return await procfs.list(`/proc/${pid}/fd`);
    } catch (error) {
      if (isErrno(error, ...GONE_CODES, ...FOREIGN_CODES)) return [];
      throw error;
    }
  };

  const identityOfFd = async (pid: number, fd: string): Promise<FileIdentity | undefined> => {
    try {
      return await procfs.identityOf(`/proc/${pid}/fd/${fd}`);
    } catch (error) {
      if (isErrno(error, ...GONE_CODES, ...FOREIGN_CODES)) return undefined;
      throw error;
    }
  };

  return {
    startTimeOf: async (pid) => {
      const stat = await statOf(pid);
      if (stat === undefined) return undefined;
      const { bootMs, ticksPerSecond } = await clockParameters();
      return bootMs + Number((stat.startTicks * 1000n) / BigInt(ticksPerSecond));
    },
    holdersOf: async (marker) => {
      let target: FileIdentity;
      try {
        target = await procfs.identityOf(marker);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return [];
        throw error;
      }
      const pids = (await procfs.list('/proc')).filter(isPidDirectoryName).map(Number);
      const holders: number[] = [];
      for (const pid of pids) {
        for (const fd of await listFds(pid)) {
          const identity = await identityOfFd(pid, fd);
          if (identity !== undefined && identity.dev === target.dev && identity.ino === target.ino) {
            holders.push(pid);
            break;
          }
        }
      }
      return holders;
    },
    groupsOf: async (pids) => {
      const groups = new Map<number, number>();
      for (const pid of pids) {
        const stat = await statOf(pid);
        if (stat !== undefined) groups.set(pid, stat.groupId);
      }
      return groups;
    },
  };
};
