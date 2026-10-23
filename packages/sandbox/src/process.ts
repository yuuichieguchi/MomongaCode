import { spawn } from 'node:child_process';
import type { SandboxExit, SandboxedProcess } from './types.ts';

export interface LaunchOptions {
  file: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  signal: AbortSignal;
  killGraceMs: number;
  afterExit: () => void;
}

const POLL_INTERVAL_MS = 10;

function assertSignalableGroup(pgid: number): void {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`refusing to signal process group ${pgid}`);
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  assertSignalableGroup(pgid);
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function groupAlive(pgid: number): boolean {
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

async function waitForGroupGone(pgid: number, deadline: number): Promise<boolean> {
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await sleep(POLL_INTERVAL_MS);
  }
  return true;
}

export function launch(options: LaunchOptions): SandboxedProcess {
  const child = spawn(options.file, [...options.args], {
    cwd: options.cwd,
    env: { ...options.env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  if (pid === undefined) {
    child.once('error', () => undefined);
    throw new Error(`failed to spawn ${options.file} in ${options.cwd}`);
  }
  const { signal, killGraceMs } = options;
  let killedBy: SandboxExit['killedBy'];
  let leaderExited = false;
  let termDeadline: number | undefined;
  let graceTimer: NodeJS.Timeout | undefined;

  const onAbort = (): void => {
    if (killedBy !== undefined) return;
    killedBy = 'abort';
    termDeadline = Date.now() + killGraceMs;
    signalGroup(pid, 'SIGTERM');
    graceTimer = setTimeout(() => {
      graceTimer = undefined;
      if (!leaderExited) killedBy = 'grace-kill';
      signalGroup(pid, 'SIGKILL');
    }, killGraceMs);
  };

  const reapGroup = async (): Promise<void> => {
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer);
      graceTimer = undefined;
    }
    if (!groupAlive(pid)) return;
    if (termDeadline === undefined) {
      termDeadline = Date.now() + killGraceMs;
      signalGroup(pid, 'SIGTERM');
    }
    if (await waitForGroupGone(pid, termDeadline)) return;
    signalGroup(pid, 'SIGKILL');
    if (!(await waitForGroupGone(pid, Date.now() + Math.max(killGraceMs, 1000)))) {
      throw new Error(`process group ${pid} did not terminate after SIGKILL`);
    }
  };

  const exited = new Promise<SandboxExit>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, exitSignal) => {
      leaderExited = true;
      signal.removeEventListener('abort', onAbort);
      reapGroup()
        .then(() => {
          options.afterExit();
          resolve({ code, signal: exitSignal, ...(killedBy === undefined ? {} : { killedBy }) });
        })
        .catch(reject);
    });
  });

  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();

  return { pid, pgid: pid, stdout: child.stdout, stderr: child.stderr, exited };
}
