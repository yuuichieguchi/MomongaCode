import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { isProcessAlive } from './process-alive.ts';
import type { CommandRunner } from './platform/command-runner.ts';
import { createDarwinInspector } from './platform/darwin-inspector.ts';
import type { ProcessInspector } from './platform/inspector-types.ts';
import { PS_PROBE_TIMEOUT_MS, createProcessInspector, hostInspectorPorts } from './platform/process-inspector.ts';
import type { InspectorPorts } from './platform/process-inspector.ts';

export type DescribeHolder = (pid: number) => Promise<string>;

export interface ProcessLock {
  release(): void;
}

export class ProcessLockHeldError extends Error {
  readonly lockPath: string;
  readonly holderPid: number;

  constructor(message: string, lockPath: string, holderPid: number) {
    super(message);
    this.name = 'ProcessLockHeldError';
    this.lockPath = lockPath;
    this.holderPid = holderPid;
  }
}

export const GARBLED_LOCK_GRACE_MS = 2000;
export const LOCK_START_TOLERANCE_MS = 2000;
export const GHOST_CONFIRM_MS = 250;
const ABANDONED_TAKEOVER_MS = 10000;
const LOCK_RETRY_MS = 25;

export type LockObservation = { kind: 'missing' } | { kind: 'pid'; pid: number; modifiedAtMs: number } | { kind: 'garbled'; modifiedAtMs: number };

const readLockState = async (lockPath: string): Promise<LockObservation> => {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(lockPath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  let raw: string;
  let modifiedAtMs: number;
  try {
    modifiedAtMs = (await handle.stat()).mtimeMs;
    raw = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  const pid = Number.parseInt(raw, 10);
  if (Number.isInteger(pid) && pid > 0) return { kind: 'pid', pid, modifiedAtMs };
  return { kind: 'garbled', modifiedAtMs };
};

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type LockTiming = { now(): number; sleep(ms: number): Promise<void> };

const realLockTiming: LockTiming = { now: () => Date.now(), sleep: pause };

const tryCreateLock = async (lockPath: string): Promise<boolean> => {
  const temporary = `${lockPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.promises.writeFile(temporary, String(process.pid), { flag: 'wx', mode: 0o600 });
  try {
    await fs.promises.link(temporary, lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
};

const sameState = (current: LockObservation, observed: LockObservation): boolean => {
  if (current.kind === 'missing' || observed.kind === 'missing') return current.kind === observed.kind;
  if (current.kind === 'pid' && observed.kind === 'pid') return current.pid === observed.pid && current.modifiedAtMs === observed.modifiedAtMs;
  return current.kind === observed.kind && current.modifiedAtMs === observed.modifiedAtMs;
};

const removeStaleLock = async (lockPath: string, observed: LockObservation, timing: LockTiming): Promise<void> => {
  const mutex = `${lockPath}.takeover`;
  try {
    await fs.promises.mkdir(mutex, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const age = await fs.promises.stat(mutex).then(
      (stat) => timing.now() - stat.mtimeMs,
      (statError: NodeJS.ErrnoException) => {
        if (statError.code === 'ENOENT') return 0;
        throw statError;
      },
    );
    if (age > ABANDONED_TAKEOVER_MS) await fs.promises.rm(mutex, { recursive: true, force: true });
    else await timing.sleep(LOCK_RETRY_MS);
    return;
  }
  try {
    if (sameState(await readLockState(lockPath), observed)) await fs.promises.rm(lockPath, { force: true });
  } finally {
    await fs.promises.rm(mutex, { recursive: true, force: true });
  }
};

const releaseLock = (lockPath: string): void => {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (Number.parseInt(raw, 10) !== process.pid) return;
  fs.rmSync(lockPath, { force: true });
};

export type ProcessStartProbe = (pid: number) => Promise<number | undefined>;

export type LockVerdictMemo = { heldPid?: number; heldModifiedAtMs?: number };

export type LockVerdict = 'missing' | 'stale' | 'held' | 'unreadable';

export type JudgeLockDependencies = {
  isAlive(pid: number): boolean;
  startTimeOf: ProcessStartProbe;
  reobserve(): Promise<LockObservation>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  memo?: LockVerdictMemo;
};

export type AcquireProcessLockOptions = { startTimeOf?: ProcessStartProbe; timing?: LockTiming };

export type InspectProcessLockOptions = { startTimeOf?: ProcessStartProbe; memo?: LockVerdictMemo; timing?: LockTiming };

export type ProcessLockInspection = { state: 'free' } | { state: 'held'; pid: number } | { state: 'unreadable' };

export { PS_PROBE_TIMEOUT_MS };

export type ProbeExecFile = (
  file: string,
  args: readonly string[],
  options: { env: Record<string, string>; timeout: number; killSignal: NodeJS.Signals },
  callback: (error: Error | null, stdout: string) => void,
) => void;

export type ProcessStartProbeDependencies = {
  execFile: ProbeExecFile;
  timeoutMs: number;
  platform?: NodeJS.Platform;
  inspectorPorts?: Partial<InspectorPorts>;
};

const commandRunnerOf =
  (run: ProbeExecFile, timeoutMs: number): CommandRunner =>
  (file, args, options) =>
    new Promise((resolve, reject) => {
      run(file, args, { env: { ...options.env }, timeout: options.timeoutMs ?? timeoutMs, killSignal: 'SIGKILL' }, (error, stdout) => {
        if (error === null) resolve({ exitCode: 0, stdout, stderr: '' });
        else reject(error);
      });
    });

export const createProcessStartProbe = (dependencies: ProcessStartProbeDependencies): ProcessStartProbe => {
  const { execFile: run, timeoutMs, platform = process.platform } = dependencies;
  let inspector: ProcessInspector | undefined;
  return (pid) => {
    inspector ??=
      platform === 'darwin'
        ? createDarwinInspector({ run: commandRunnerOf(run, timeoutMs), startTimeoutMs: timeoutMs })
        : createProcessInspector(platform, { ...hostInspectorPorts(), ...dependencies.inspectorPorts, startTimeoutMs: timeoutMs });
    return inspector.startTimeOf(pid);
  };
};

export const defaultProcessStartProbe: ProcessStartProbe = createProcessStartProbe({
  execFile: (file, args, options, callback) => {
    execFile(file, [...args], options, (error, stdout) => callback(error, stdout));
  },
  timeoutMs: PS_PROBE_TIMEOUT_MS,
});

export const createLockVerdictMemo = (): LockVerdictMemo => ({});

const startsAfterLock = (startedAt: number | undefined, modifiedAtMs: number): boolean =>
  startedAt !== undefined && startedAt > modifiedAtMs + LOCK_START_TOLERANCE_MS;

export const judgeLock = async (observation: LockObservation, dependencies: JudgeLockDependencies): Promise<LockVerdict> => {
  const { isAlive, startTimeOf, reobserve, memo, now = realLockTiming.now, sleep = realLockTiming.sleep } = dependencies;
  const settle = (verdict: LockVerdict): LockVerdict => {
    if (memo === undefined) return verdict;
    if (verdict === 'held' && observation.kind === 'pid') {
      memo.heldPid = observation.pid;
      memo.heldModifiedAtMs = observation.modifiedAtMs;
    } else {
      delete memo.heldPid;
      delete memo.heldModifiedAtMs;
    }
    return verdict;
  };
  if (observation.kind === 'missing') return settle('missing');
  if (observation.kind === 'garbled') return settle(now() - observation.modifiedAtMs > GARBLED_LOCK_GRACE_MS ? 'stale' : 'unreadable');
  const { pid, modifiedAtMs } = observation;
  if (!isAlive(pid)) return settle('stale');
  if (memo?.heldPid === pid && memo.heldModifiedAtMs === modifiedAtMs) return settle('held');
  if (!startsAfterLock(await startTimeOf(pid), modifiedAtMs)) return settle('held');
  await sleep(GHOST_CONFIRM_MS);
  const current = await reobserve();
  const confirmedStart = await startTimeOf(pid);
  if (current.kind !== 'pid' || current.pid !== pid || current.modifiedAtMs !== modifiedAtMs) return judgeLock(current, dependencies);
  return settle(startsAfterLock(confirmedStart, modifiedAtMs) ? 'stale' : 'held');
};

export const inspectProcessLock = async (lockPath: string, options: InspectProcessLockOptions = {}): Promise<ProcessLockInspection> => {
  const timing = options.timing ?? realLockTiming;
  let observed = await readLockState(lockPath);
  const verdict = await judgeLock(observed, {
    isAlive: isProcessAlive,
    startTimeOf: options.startTimeOf ?? defaultProcessStartProbe,
    reobserve: async () => (observed = await readLockState(lockPath)),
    now: timing.now,
    sleep: timing.sleep,
    ...(options.memo === undefined ? {} : { memo: options.memo }),
  });
  if (verdict === 'unreadable') return { state: 'unreadable' };
  if (verdict !== 'held') return { state: 'free' };
  if (observed.kind !== 'pid') throw new Error(`lock ${lockPath} was judged held without a holder pid`);
  return { state: 'held', pid: observed.pid };
};

const acquireLock = async (lockPath: string, describeHolder: DescribeHolder, startTimeOf: ProcessStartProbe, timing: LockTiming): Promise<void> => {
  for (;;) {
    if (await tryCreateLock(lockPath)) return;
    let observed = await readLockState(lockPath);
    const verdict = await judgeLock(observed, {
      isAlive: isProcessAlive,
      startTimeOf,
      reobserve: async () => (observed = await readLockState(lockPath)),
      now: timing.now,
      sleep: timing.sleep,
    });
    if (verdict === 'missing') continue;
    if (verdict === 'unreadable') {
      await timing.sleep(LOCK_RETRY_MS);
      continue;
    }
    if (verdict === 'stale') {
      await removeStaleLock(lockPath, observed, timing);
      continue;
    }
    if (observed.kind !== 'pid') throw new Error(`lock ${lockPath} was judged held without a holder pid`);
    throw new ProcessLockHeldError(await describeHolder(observed.pid), lockPath, observed.pid);
  }
};

export const acquireProcessLock = async (
  lockPath: string,
  describeHolder: DescribeHolder = async (pid) => `${lockPath} is held by live process ${pid}; remove it if that process is not momonga`,
  options: AcquireProcessLockOptions = {},
): Promise<ProcessLock> => {
  await acquireLock(lockPath, describeHolder, options.startTimeOf ?? defaultProcessStartProbe, options.timing ?? realLockTiming);
  return { release: () => releaseLock(lockPath) };
};
