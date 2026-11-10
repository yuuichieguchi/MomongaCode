import { hostProcessGroupPort } from './platform/group-port.ts';
import type { ProcessGroupPort } from './platform/group-port.ts';
import type { GroupMembersReader } from './platform/group-members.ts';

const POLL_INTERVAL_MS = 10;

export interface GroupTiming {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realGroupTiming: GroupTiming = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type TerminateOutcome = 'terminated' | 'killed' | 'gone' | 'unconfirmed';

export const groupTerminationBoundMs = (graceMs: number): number => 2 * (graceMs + POLL_INTERVAL_MS);

export class GroupNotStoppedError extends Error {
  readonly pgid: number;

  constructor(pgid: number) {
    super(`process group ${pgid} was not stopped: a member that can still run remained after SIGTERM and SIGKILL`);
    this.name = 'GroupNotStoppedError';
    this.pgid = pgid;
  }
}

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

export function signalGroupExceptLeader(pgid: number, signal: NodeJS.Signals, reader: GroupMembersReader, send: ProcessSignalSender = sendToProcess): number {
  assertSignalableGroup(pgid);
  let signalled = 0;
  for (const { pid, startTicks } of reader.members(pgid)) {
    if (pid === pgid) continue;
    const now = reader.statOf(pid);
    if (now === undefined || now.groupId !== pgid || now.startTicks !== startTicks) continue;
    signalled += 1;
    try {
      send(pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH' && code !== 'EPERM') throw error;
    }
  }
  return signalled;
}

export async function groupAlive(pgid: number, port: ProcessGroupPort = hostProcessGroupPort(), stop?: AbortSignal): Promise<boolean> {
  assertSignalableGroup(pgid);
  return port.alive(pgid, { signal: stop });
}

type GroupProbe = 'alive' | 'gone' | 'stopped';

const probeGroup = async (pgid: number, port: ProcessGroupPort, stop: AbortSignal | undefined): Promise<GroupProbe> => {
  try {
    if (!(await groupAlive(pgid, port, stop))) return 'gone';
  } catch (error) {
    if (stop?.aborted === true) return 'stopped';
    throw error;
  }
  return stop?.aborted === true ? 'stopped' : 'alive';
};

export async function waitForGroupGone(
  pgid: number,
  deadline: number,
  port: ProcessGroupPort = hostProcessGroupPort(),
  timing: GroupTiming = realGroupTiming,
  stop?: AbortSignal,
): Promise<boolean> {
  for (;;) {
    const probe = await probeGroup(pgid, port, stop);
    if (probe !== 'alive') return probe === 'gone';
    if (timing.now() >= deadline) return false;
    await timing.sleep(POLL_INTERVAL_MS);
  }
}

export interface ForceKillGroupOptions {
  deadline: number;
  port?: ProcessGroupPort;
  timing?: GroupTiming;
  signal?: AbortSignal | undefined;
}

export async function forceKillGroup(pgid: number, { deadline, port = hostProcessGroupPort(), timing = realGroupTiming, signal }: ForceKillGroupOptions): Promise<boolean> {
  for (;;) {
    const probe = await probeGroup(pgid, port, signal);
    if (probe !== 'alive') return probe === 'gone';
    await signalGroup(pgid, 'SIGKILL', port, signal);
    if (timing.now() >= deadline) return (await probeGroup(pgid, port, signal)) === 'gone';
    await timing.sleep(POLL_INTERVAL_MS);
  }
}

export async function terminateGroup(pgid: number, options: TerminateGroupOptions): Promise<TerminateOutcome> {
  const port = options.port ?? hostProcessGroupPort();
  const timing = options.timing ?? realGroupTiming;
  const { signal } = options;
  const first = await probeGroup(pgid, port, signal);
  if (first !== 'alive') return first === 'gone' ? 'gone' : 'unconfirmed';
  let termDeadline = options.termDeadline;
  if (termDeadline === undefined) {
    termDeadline = timing.now() + options.graceMs;
    await signalGroup(pgid, 'SIGTERM', port, signal);
  }
  if (await waitForGroupGone(pgid, termDeadline, port, timing, signal)) return 'terminated';
  if (signal?.aborted === true) return 'unconfirmed';
  return (await forceKillGroup(pgid, { deadline: timing.now() + options.graceMs, port, timing, signal })) ? 'killed' : 'unconfirmed';
}
