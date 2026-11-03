import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { groupTerminationBoundMs, signalGroup, terminateGroup } from '@momonga/foundation';
import type { SandboxExit, SandboxedProcess } from './types.ts';

export const SANDBOX_KILL_GRACE_MS = 1000;

export const SANDBOX_STOP_BOUND_MS = groupTerminationBoundMs(SANDBOX_KILL_GRACE_MS);

export interface LaunchOptions {
  file: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  signal: AbortSignal;
  killGraceMs: number;
  afterExit: () => void;
  markerFile?: string;
  stdin?: string;
  spawnProcess?: typeof spawn;
  signalTerm?: (pgid: number) => void;
}

const signalWholeGroupTerm = (pgid: number): void => signalGroup(pgid, 'SIGTERM');

export function launch(options: LaunchOptions): SandboxedProcess {
  const spawnProcess = options.spawnProcess ?? spawn;
  const stdinMode = options.stdin === undefined ? 'ignore' : 'pipe';
  const markerFd = options.markerFile === undefined ? undefined : fs.openSync(options.markerFile, 'r');
  let child: ReturnType<typeof spawn>;
  try {
    child = spawnProcess(options.file, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      detached: true,
      windowsHide: true,
      stdio: markerFd === undefined ? [stdinMode, 'pipe', 'pipe'] : [stdinMode, 'pipe', 'pipe', markerFd],
    });
  } finally {
    if (markerFd !== undefined) fs.closeSync(markerFd);
  }
  const pid = child.pid;
  if (pid === undefined) {
    child.once('error', () => undefined);
    throw new Error(`failed to spawn ${options.file} in ${options.cwd}`);
  }
  const { stdout, stderr, stdin } = child;
  if (stdout === null || stderr === null) {
    child.once('error', () => undefined);
    signalGroup(pid, 'SIGKILL');
    throw new Error(`failed to open output pipes for ${options.file}`);
  }
  const { signal, killGraceMs } = options;
  const signalTerm = options.signalTerm ?? signalWholeGroupTerm;
  let stdinFailure: Error | undefined;
  if (options.stdin !== undefined && stdin !== null) {
    stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') stdinFailure ??= error;
    });
    stdin.end(options.stdin);
  }
  let killedBy: SandboxExit['killedBy'];
  let leaderExited = false;
  let termDeadline: number | undefined;
  let graceTimer: NodeJS.Timeout | undefined;

  const onAbort = (): void => {
    if (killedBy !== undefined) return;
    killedBy = 'abort';
    termDeadline = Date.now() + killGraceMs;
    signalTerm(pid);
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
    await terminateGroup(pid, termDeadline === undefined ? { graceMs: killGraceMs } : { graceMs: killGraceMs, termDeadline });
  };

  let afterExitRan = false;
  const afterExitOnce = (): void => {
    if (afterExitRan) return;
    afterExitRan = true;
    options.afterExit();
  };

  const reapAndClean = async (): Promise<void> => {
    const failures: unknown[] = [];
    try {
      await reapGroup();
    } catch (error) {
      failures.push(error);
    }
    try {
      afterExitOnce();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'the process group could not be reaped and the cleanup after it failed');
  };

  let childError: Error | undefined;

  const exited = new Promise<SandboxExit>((resolve, reject) => {
    child.once('error', (error) => {
      childError = error;
      signal.removeEventListener('abort', onAbort);
      reapAndClean().then(() => reject(error), reject);
    });
    child.once('exit', (code, exitSignal) => {
      leaderExited = true;
      signal.removeEventListener('abort', onAbort);
      reapAndClean().then(() => {
        if (childError !== undefined) {
          reject(childError);
          return;
        }
        if (stdinFailure !== undefined) {
          reject(stdinFailure);
          return;
        }
        resolve({ code, signal: exitSignal, ...(killedBy === undefined ? {} : { killedBy }) });
      }, reject);
    });
  });

  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();

  return { pid, pgid: pid, stdout, stderr, exited };
}
