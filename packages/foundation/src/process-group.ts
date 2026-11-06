import { hostProcessGroupPort } from './platform/group-port.ts';
import type { ProcessGroupPort } from './platform/group-port.ts';
import type { GroupMembersReader } from './platform/group-members.ts';

const POLL_INTERVAL_MS = 10;
const MIN_KILL_WAIT_MS = 1000;

export interface GroupTiming {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realGroupTiming: GroupTiming = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type TerminateOutcome = 'terminated' | 'killed' | 'gone';

const killWaitMs = (graceMs: number): number => Math.max(graceMs, MIN_KILL_WAIT_MS);

export const groupTerminationBoundMs = (graceMs: number): number => graceMs + POLL_INTERVAL_MS + killWaitMs(graceMs) + POLL_INTERVAL_MS;

export interface TerminateGroupOptions {
  graceMs: number;
  termDeadline?: number;
  port?: ProcessGroupPort;
  timing?: GroupTiming;
  signal?: AbortSignal | undefined;
}

function assertSignalableGroup(pgid: number): void {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`refusing to signal process group ${pgid}`);
}

export async function signalGroup(pgid: number, signal: NodeJS.Signals, port: ProcessGroupPort = hostProcessGroupPort(), stop?: AbortSignal): Promise<void> {
  assertSignalableGroup(pgid);
  await port.signal(pgid, signal, { signal: stop });
}

export type ProcessSignalSender = (pid: number, signal: NodeJS.Signals) => void;

const sendToProcess: ProcessSignalSender = (pid, signal) => void process.kill(pid, signal);

export function signalGroupExceptLeader(pgid: number, signal: NodeJS.Signals, members: GroupMembersReader, send: ProcessSignalSender = sendToProcess): number {
  assertSignalableGroup(pgid);
  const followers = members(pgid).filter((pid) => pid !== pgid);
  for (const pid of followers) {
    try {
      send(pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH' && code !== 'EPERM') throw error;
    }
  }
  return followers.length;
}

export async function groupAlive(pgid: number, port: ProcessGroupPort = hostProcessGroupPort(), stop?: AbortSignal): Promise<boolean> {
  assertSignalableGroup(pgid);
  return port.alive(pgid, { signal: stop });
}

export async function waitForGroupGone(
  pgid: number,
  deadline: number,
  port: ProcessGroupPort = hostProcessGroupPort(),
  timing: GroupTiming = realGroupTiming,
  stop?: AbortSignal,
): Promise<boolean> {
  while (await groupAlive(pgid, port, stop)) {
    if (timing.now() >= deadline) return false;
    await timing.sleep(POLL_INTERVAL_MS);
  }
  return true;
}

export interface ForceKillGroupOptions {
  deadline: number;
  port?: ProcessGroupPort;
  timing?: GroupTiming;
  signal?: AbortSignal | undefined;
}

export async function forceKillGroup(pgid: number, { deadline, port = hostProcessGroupPort(), timing = realGroupTiming, signal }: ForceKillGroupOptions): Promise<boolean> {
  while (await groupAlive(pgid, port, signal)) {
    await signalGroup(pgid, 'SIGKILL', port, signal);
    if (timing.now() >= deadline) return false;
    await timing.sleep(POLL_INTERVAL_MS);
  }
  return true;
}

export async function terminateGroup(pgid: number, options: TerminateGroupOptions): Promise<TerminateOutcome> {
  const port = options.port ?? hostProcessGroupPort();
  const timing = options.timing ?? realGroupTiming;
  const { signal } = options;
  if (!(await groupAlive(pgid, port, signal))) return 'gone';
  let termDeadline = options.termDeadline;
  if (termDeadline === undefined) {
    termDeadline = timing.now() + options.graceMs;
    await signalGroup(pgid, 'SIGTERM', port, signal);
  }
  if (await waitForGroupGone(pgid, termDeadline, port, timing, signal)) return 'terminated';
  if (!(await forceKillGroup(pgid, { deadline: timing.now() + killWaitMs(options.graceMs), port, timing, signal }))) {
    throw new Error(`process group ${pgid} did not terminate after SIGKILL`);
  }
  return 'killed';
}
