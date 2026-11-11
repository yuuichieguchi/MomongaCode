import { groupSignalsOf, hostProcessGroupPort } from './platform/group-port.ts';
import type { ProcessGroupPort } from './platform/group-port.ts';
import type { GroupMembersReader } from './platform/group-members.ts';
import { KILL_CONFIRM_MS } from './process-contract.ts';
import { systemWaitTiming } from './system-timing.ts';
import { sleep } from './timing.ts';
import type { Timing } from './timing.ts';
import { POLL_INTERVAL_MS, waitUntil } from './wait-until.ts';

export { groupTerminationBoundMs } from './process-contract.ts';

export type TerminateOutcome = 'terminated' | 'killed' | 'gone' | 'unconfirmed';

export interface TerminateGroupOptions {
  graceMs: number;
  termDeadline?: number;
  port?: ProcessGroupPort;
  timing?: Timing;
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

const endOfGroup = async (pgid: number, port: ProcessGroupPort, stop: AbortSignal | undefined): Promise<Exclude<GroupProbe, 'alive'> | undefined> => {
  const probe = await probeGroup(pgid, port, stop);
  return probe === 'alive' ? undefined : probe;
};

const pushedEnd = async (pgid: number, deadline: number, port: ProcessGroupPort, ended: NonNullable<ProcessGroupPort['ended']>, timing: Timing, stop: AbortSignal | undefined): Promise<void> => {
  const wait = new AbortController();
  const leave = (): void => wait.abort(stop?.reason);
  stop?.addEventListener('abort', leave, { once: true });
  try {
    const pushed = ended.call(port, pgid, { signal: wait.signal }).then(
      () => undefined,
      (error: unknown) => {
        if (wait.signal.aborted) return undefined;
        throw error;
      },
    );
    await Promise.race([pushed, sleep(timing, Math.max(0, deadline - timing.monotonicMs()), wait.signal)]);
  } finally {
    stop?.removeEventListener('abort', leave);
    wait.abort();
  }
};

export async function waitForGroupGone(
  pgid: number,
  deadline: number,
  port: ProcessGroupPort = hostProcessGroupPort(),
  timing: Timing = systemWaitTiming,
  stop?: AbortSignal,
): Promise<boolean> {
  if (port.ended !== undefined) {
    const first = await probeGroup(pgid, port, stop);
    if (first !== 'alive') return first === 'gone';
    if (timing.monotonicMs() >= deadline) return false;
    await pushedEnd(pgid, deadline, port, port.ended, timing, stop);
    return (await probeGroup(pgid, port, stop)) === 'gone';
  }
  const ended = await waitUntil(timing, () => endOfGroup(pgid, port, stop), { intervalMs: POLL_INTERVAL_MS, deadline, signal: stop });
  return ended.kind === 'found' && ended.value === 'gone';
}

export interface ForceKillGroupOptions {
  deadline: number;
  port?: ProcessGroupPort;
  timing?: Timing;
  signal?: AbortSignal | undefined;
}

export async function forceKillGroup(pgid: number, { deadline, port = hostProcessGroupPort(), timing = systemWaitTiming, signal }: ForceKillGroupOptions): Promise<boolean> {
  const signals = groupSignalsOf(port);
  const last = signals[signals.length - 1] ?? signals[0];
  const endedOrKilledAgain = async (): Promise<Exclude<GroupProbe, 'alive'> | undefined> => {
    const ended = await endOfGroup(pgid, port, signal);
    if (ended === undefined) await signalGroup(pgid, last, port, signal);
    return ended;
  };
  const ended = await waitUntil(timing, endedOrKilledAgain, { intervalMs: POLL_INTERVAL_MS, deadline, signal });
  if (ended.kind === 'found') return ended.value === 'gone';
  return (await probeGroup(pgid, port, signal)) === 'gone';
}

export async function terminateGroup(pgid: number, options: TerminateGroupOptions): Promise<TerminateOutcome> {
  const port = options.port ?? hostProcessGroupPort();
  const timing = options.timing ?? systemWaitTiming;
  const { signal } = options;
  const signals = groupSignalsOf(port);
  const first = await probeGroup(pgid, port, signal);
  if (first !== 'alive') return first === 'gone' ? 'gone' : 'unconfirmed';
  let termDeadline = options.termDeadline;
  if (termDeadline === undefined) {
    termDeadline = timing.monotonicMs() + options.graceMs;
    await signalGroup(pgid, signals[0], port, signal);
  }
  if (await waitForGroupGone(pgid, termDeadline, port, timing, signal)) return 'terminated';
  if (signal?.aborted === true || signals.length === 1) return 'unconfirmed';
  return (await forceKillGroup(pgid, { deadline: timing.monotonicMs() + KILL_CONFIRM_MS, port, timing, signal })) ? 'killed' : 'unconfirmed';
}
