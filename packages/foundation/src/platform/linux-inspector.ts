import os from 'node:os';
import { failureOfError, isErrno, probeFailed } from './inspector-types.ts';
import type { ProbeFailure, ProbeResult, ProcessInspector } from './inspector-types.ts';
import { auxvLayoutOf, isPidDirectoryName, parseBootTimeSeconds, parseClockTicksPerSecond, parseProcStat, parseRealUid } from './linux-parsers.ts';
import type { AuxvLayout } from './linux-parsers.ts';
import { PS_PROBE_TIMEOUT_MS, REAP_POLL_INTERVAL_MS, hostProbeTiming } from './probe-timing.ts';
import type { ProbeTiming } from './probe-timing.ts';
import type { FileIdentity, ProcFs } from './procfs.ts';

export type LinuxInspectorPorts = { procfs: ProcFs; uid: number; layout?: AuxvLayout; timing?: ProbeTiming };

const hostLayout = (): AuxvLayout => auxvLayoutOf(process.arch, os.endianness());

const GONE_CODES = ['ENOENT', 'ESRCH'];
const DENIED_CODES = ['EACCES', 'EPERM'];
const EXITED_STATES = ['Z', 'X'];

export const BOOT_TIME_RESOLUTION_MS = 1000;

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

export const createLinuxInspector = ({ procfs, uid, layout, timing = hostProbeTiming }: LinuxInspectorPorts): ProcessInspector => {
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

  const hasExited = async (pid: number): Promise<boolean> => {
    const stat = await statOf(pid);
    return stat === undefined || EXITED_STATES.includes(stat.state);
  };

  const realUidOf = async (pid: number): Promise<number | undefined> => {
    try {
      const text = await procfs.readText(`/proc/${pid}/status`);
      return parsed(() => parseRealUid(text));
    } catch (error) {
      if (isErrno(error, ...GONE_CODES)) return undefined;
      throw error;
    }
  };

  const startedBeforeMarker = async (pid: number, markerBirthMs: number): Promise<boolean> => {
    if (markerBirthMs <= 0) return false;
    const stat = await statOf(pid);
    if (stat === undefined) return true;
    const { bootMs, ticksPerSecond } = await clockParameters();
    const startedMs = bootMs + Number((stat.startTicks * 1000n) / BigInt(ticksPerSecond));
    return startedMs + 1000 / ticksPerSecond + BOOT_TIME_RESOLUTION_MS < markerBirthMs;
  };

  const unlessUnsettled = async <T>(pid: number, markerBirthMs: number, absent: T, read: () => Promise<T>): Promise<T> => {
    const deadline = timing.now() + PS_PROBE_TIMEOUT_MS;
    for (;;) {
      try {
        return await read();
      } catch (error) {
        if (isErrno(error, ...GONE_CODES)) return absent;
        if (!isErrno(error, ...DENIED_CODES)) throw error;
        if (await hasExited(pid)) return absent;
        const owner = await realUidOf(pid);
        if (owner === undefined || owner !== uid) return absent;
        if (await startedBeforeMarker(pid, markerBirthMs)) return absent;
        if (timing.now() >= deadline) {
          throw new Uninspectable(`process ${pid} belongs to the current user but its descriptors are not readable (${(error as Error).message})`);
        }
        await timing.sleep(REAP_POLL_INTERVAL_MS);
      }
    }
  };

  const fdsOf = (pid: number, markerBirthMs: number, base: string): Promise<string[]> =>
    unlessUnsettled<string[]>(pid, markerBirthMs, [], () => procfs.list(`${base}/fd`));

  const identityOfFd = (pid: number, markerBirthMs: number, base: string, fd: string): Promise<FileIdentity | undefined> =>
    unlessUnsettled<FileIdentity | undefined>(pid, markerBirthMs, undefined, () => procfs.identityOf(`${base}/fd/${fd}`));

  const liveThreadsOfZombie = async (pid: number): Promise<string[]> => {
    const stat = await statOf(pid);
    if (stat?.state !== 'Z') return [];
    try {
      return (await procfs.list(`/proc/${pid}/task`)).filter((tid) => tid !== String(pid));
    } catch (error) {
      if (isErrno(error, ...GONE_CODES)) return [];
      throw error;
    }
  };

  const holdsMarker = async (pid: number, markerBirthMs: number, base: string, target: FileIdentity): Promise<boolean> => {
    for (const fd of await fdsOf(pid, markerBirthMs, base)) {
      const identity = await identityOfFd(pid, markerBirthMs, base, fd);
      if (identity !== undefined && identity.dev === target.dev && identity.ino === target.ino) return true;
    }
    return false;
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
        const markerBirthMs = await procfs.birthMsOf(marker);
        const pids = (await procfs.list('/proc')).filter(isPidDirectoryName).map(Number);
        const holders: number[] = [];
        for (const pid of pids) {
          if (await holdsMarker(pid, markerBirthMs, `/proc/${pid}`, target)) {
            holders.push(pid);
            continue;
          }
          for (const tid of await liveThreadsOfZombie(pid)) {
            if (await holdsMarker(pid, markerBirthMs, `/proc/${pid}/task/${tid}`, target)) {
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
