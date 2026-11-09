import os from 'node:os';
import { failureOfError, isErrno, probeFailed } from './inspector-types.ts';
import { withListedState } from './marker-state.ts';
import type { ProbeFailure, ProbeResult, ProcessInspector, UninspectableProcess } from './inspector-types.ts';
import { auxvLayoutOf, isPidDirectoryName, parseBootTimeSeconds, parseClockTicksPerSecond, parseProcStat, parseRealUid } from './linux-parsers.ts';
import type { AuxvLayout } from './linux-parsers.ts';
import type { FileIdentity, ProcFs } from './procfs.ts';
import type { GroupStatesReader } from './run-state.ts';

export type LinuxInspectorPorts = { procfs: ProcFs; uid: number; layout?: AuxvLayout };

const hostLayout = (): AuxvLayout => auxvLayoutOf(process.arch, os.endianness());

const GONE_CODES = ['ENOENT', 'ESRCH'];
const DENIED_CODES = ['EACCES', 'EPERM'];
const EXITED_STATES = ['Z', 'X'];

export const BOOT_TIME_RESOLUTION_MS = 1000;

type ClockParameters = { bootMs: number; ticksPerSecond: number };

type Scan = { markerBirthMs: number; report: ((process: UninspectableProcess) => void) | undefined };

class UnparseableProcfs extends Error {}

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

  const unlessUnsettled = async <T>(pid: number, scan: Scan, absent: T, read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      if (isErrno(error, ...GONE_CODES)) return absent;
      if (!isErrno(error, ...DENIED_CODES)) throw error;
      const stat = await statOf(pid);
      if (stat === undefined || EXITED_STATES.includes(stat.state)) return absent;
      const owner = await realUidOf(pid);
      if (owner === undefined || owner !== uid) return absent;
      if (await startedBeforeMarker(pid, scan.markerBirthMs)) return absent;
      scan.report?.({ pid, command: stat.command, startTicks: String(stat.startTicks) });
      return absent;
    }
  };

  const fdsOf = (pid: number, scan: Scan, base: string): Promise<string[]> => unlessUnsettled<string[]>(pid, scan, [], () => procfs.list(`${base}/fd`));

  const identityOfFd = (pid: number, scan: Scan, base: string, fd: string): Promise<FileIdentity | undefined> =>
    unlessUnsettled<FileIdentity | undefined>(pid, scan, undefined, () => procfs.identityOf(`${base}/fd/${fd}`));

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

  const holdsMarker = async (pid: number, scan: Scan, base: string, target: FileIdentity): Promise<boolean> => {
    for (const fd of await fdsOf(pid, scan, base)) {
      const identity = await identityOfFd(pid, scan, base, fd);
      if (identity !== undefined && identity.dev === target.dev && identity.ino === target.ino) return true;
    }
    return false;
  };

  const guarded = async <T>(read: () => Promise<ProbeResult<T>>): Promise<ProbeResult<T>> => {
    try {
      return await read();
    } catch (error) {
      return failureOf(error);
    }
  };

  return withListedState({
    startTimeOf: (pid) =>
      guarded(async () => {
        const stat = await statOf(pid);
        if (stat === undefined) return { kind: 'gone' };
        const { bootMs, ticksPerSecond } = await clockParameters();
        return { kind: 'value', value: bootMs + Number((stat.startTicks * 1000n) / BigInt(ticksPerSecond)) };
      }),
    holdersOf: (marker, { signal }, onUninspectable) =>
      guarded(async () => {
        let target: FileIdentity;
        try {
          target = await procfs.identityOf(marker);
        } catch (error) {
          if (isErrno(error, 'ENOENT')) return { kind: 'gone' };
          throw error;
        }
        const scan: Scan = { markerBirthMs: await procfs.birthMsOf(marker), report: onUninspectable };
        const pids = (await procfs.list('/proc')).filter(isPidDirectoryName).map(Number);
        const holders: number[] = [];
        for (const pid of pids) {
          signal.throwIfAborted();
          if (await holdsMarker(pid, scan, `/proc/${pid}`, target)) {
            holders.push(pid);
            continue;
          }
          for (const tid of await liveThreadsOfZombie(pid)) {
            if (await holdsMarker(pid, scan, `/proc/${pid}/task/${tid}`, target)) {
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
  });
};

export const createLinuxGroupStates =
  (procfs: ProcFs): GroupStatesReader =>
  async (pgid, { signal }) => {
    const states: string[] = [];
    for (const name of (await procfs.list('/proc')).filter(isPidDirectoryName)) {
      signal?.throwIfAborted();
      let text: string;
      try {
        text = await procfs.readText(`/proc/${name}/stat`);
      } catch (error) {
        if (isErrno(error, ...GONE_CODES)) continue;
        throw error;
      }
      const stat = parseProcStat(text);
      if (stat.groupId === pgid) states.push(stat.state);
    }
    return states;
  };
