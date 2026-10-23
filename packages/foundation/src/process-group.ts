const POLL_INTERVAL_MS = 10;
const MIN_KILL_WAIT_MS = 1000;

export type TerminateOutcome = 'terminated' | 'killed' | 'gone';

export interface TerminateGroupOptions {
  graceMs: number;
  termDeadline?: number;
}

function assertSignalableGroup(pgid: number): void {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`refusing to signal process group ${pgid}`);
}

export function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  assertSignalableGroup(pgid);
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH' && code !== 'EPERM') throw error;
  }
}

export function groupAlive(pgid: number): boolean {
  assertSignalableGroup(pgid);
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForGroupGone(pgid: number, deadline: number): Promise<boolean> {
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await sleep(POLL_INTERVAL_MS);
  }
  return true;
}

export interface ForceKillGroupOptions {
  deadline: number;
}

export async function forceKillGroup(pgid: number, { deadline }: ForceKillGroupOptions): Promise<boolean> {
  while (groupAlive(pgid)) {
    signalGroup(pgid, 'SIGKILL');
    if (Date.now() >= deadline) return false;
    await sleep(POLL_INTERVAL_MS);
  }
  return true;
}

export async function terminateGroup(pgid: number, options: TerminateGroupOptions): Promise<TerminateOutcome> {
  if (!groupAlive(pgid)) return 'gone';
  let termDeadline = options.termDeadline;
  if (termDeadline === undefined) {
    termDeadline = Date.now() + options.graceMs;
    signalGroup(pgid, 'SIGTERM');
  }
  if (await waitForGroupGone(pgid, termDeadline)) return 'terminated';
  if (!(await forceKillGroup(pgid, { deadline: Date.now() + Math.max(options.graceMs, MIN_KILL_WAIT_MS) }))) {
    throw new Error(`process group ${pgid} did not terminate after SIGKILL`);
  }
  return 'killed';
}
