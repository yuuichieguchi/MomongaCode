import { hostProcessGroupPort } from './platform/group-port.ts';
import type { ProcessGroupPort } from './platform/group-port.ts';

const POLL_INTERVAL_MS = 10;
const MIN_KILL_WAIT_MS = 1000;

export type TerminateOutcome = 'terminated' | 'killed' | 'gone';

export interface TerminateGroupOptions {
  graceMs: number;
  termDeadline?: number;
  port?: ProcessGroupPort;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForGroupGone(pgid: number, deadline: number, port: ProcessGroupPort = hostProcessGroupPort()): Promise<boolean> {
  while (groupAlive(pgid, port)) {
    if (Date.now() >= deadline) return false;
    await sleep(POLL_INTERVAL_MS);
  }
  return true;
}

export interface ForceKillGroupOptions {
  deadline: number;
  port?: ProcessGroupPort;
}

export async function forceKillGroup(pgid: number, { deadline, port = hostProcessGroupPort() }: ForceKillGroupOptions): Promise<boolean> {
  while (groupAlive(pgid, port)) {
    signalGroup(pgid, 'SIGKILL', port);
    if (Date.now() >= deadline) return false;
    await sleep(POLL_INTERVAL_MS);
  }
  return true;
}

export async function terminateGroup(pgid: number, options: TerminateGroupOptions): Promise<TerminateOutcome> {
  const port = options.port ?? hostProcessGroupPort();
  if (!groupAlive(pgid, port)) return 'gone';
  let termDeadline = options.termDeadline;
  if (termDeadline === undefined) {
    termDeadline = Date.now() + options.graceMs;
    signalGroup(pgid, 'SIGTERM', port);
  }
  if (await waitForGroupGone(pgid, termDeadline, port)) return 'terminated';
  if (!(await forceKillGroup(pgid, { deadline: Date.now() + Math.max(options.graceMs, MIN_KILL_WAIT_MS), port }))) {
    throw new Error(`process group ${pgid} did not terminate after SIGKILL`);
  }
  return 'killed';
}
