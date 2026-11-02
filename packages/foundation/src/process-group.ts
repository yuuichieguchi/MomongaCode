import { hostProcessGroupPort } from './platform/group-port.ts';
import type { ProcessGroupPort } from './platform/group-port.ts';

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
}

function assertSignalableGroup(pgid: number): void {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`refusing to signal process group ${pgid}`);
}

export function signalGroup(pgid: number, signal: NodeJS.Signals, port: ProcessGroupPort = hostProcessGroupPort()): void {
  assertSignalableGroup(pgid);
  port.signal(pgid, signal);
}

export function groupAlive(pgid: number, port: ProcessGroupPort = hostProcessGroupPort()): boolean {
  assertSignalableGroup(pgid);
  return port.alive(pgid);
}

export async function waitForGroupGone(
  pgid: number,
  deadline: number,
  port: ProcessGroupPort = hostProcessGroupPort(),
  timing: GroupTiming = realGroupTiming,
): Promise<boolean> {
  while (groupAlive(pgid, port)) {
    if (timing.now() >= deadline) return false;
    await timing.sleep(POLL_INTERVAL_MS);
  }
  return true;
}

export interface ForceKillGroupOptions {
  deadline: number;
  port?: ProcessGroupPort;
  timing?: GroupTiming;
}

export async function forceKillGroup(pgid: number, { deadline, port = hostProcessGroupPort(), timing = realGroupTiming }: ForceKillGroupOptions): Promise<boolean> {
  while (groupAlive(pgid, port)) {
    signalGroup(pgid, 'SIGKILL', port);
    if (timing.now() >= deadline) return false;
    await timing.sleep(POLL_INTERVAL_MS);
  }
  return true;
}

export async function terminateGroup(pgid: number, options: TerminateGroupOptions): Promise<TerminateOutcome> {
  const port = options.port ?? hostProcessGroupPort();
  const timing = options.timing ?? realGroupTiming;
  if (!groupAlive(pgid, port)) return 'gone';
  let termDeadline = options.termDeadline;
  if (termDeadline === undefined) {
    termDeadline = timing.now() + options.graceMs;
    signalGroup(pgid, 'SIGTERM', port);
  }
  if (await waitForGroupGone(pgid, termDeadline, port, timing)) return 'terminated';
  if (!(await forceKillGroup(pgid, { deadline: timing.now() + killWaitMs(options.graceMs), port, timing }))) {
    throw new Error(`process group ${pgid} did not terminate after SIGKILL`);
  }
  return 'killed';
}
