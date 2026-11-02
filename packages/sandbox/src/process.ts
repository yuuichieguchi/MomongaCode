import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { signalGroup, terminateGroup } from '@momonga/foundation';
import type { SandboxExit, SandboxedProcess } from './types.ts';

export interface LaunchOptions {
  file: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  signal: AbortSignal;
  killGraceMs: number;
  afterExit: () => void;
  markerFile?: string;
}

export function launch(options: LaunchOptions): SandboxedProcess {
  const markerFd = options.markerFile === undefined ? undefined : fs.openSync(options.markerFile, 'r');
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(options.file, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      detached: true,
      windowsHide: true,
      stdio: markerFd === undefined ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', markerFd],
    });
  } finally {
    if (markerFd !== undefined) fs.closeSync(markerFd);
  }
  const pid = child.pid;
  if (pid === undefined) {
    child.once('error', () => undefined);
    throw new Error(`failed to spawn ${options.file} in ${options.cwd}`);
  }
  const { stdout, stderr } = child;
  if (stdout === null || stderr === null) {
    child.once('error', () => undefined);
    signalGroup(pid, 'SIGKILL');
    throw new Error(`failed to open output pipes for ${options.file}`);
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
    await terminateGroup(pid, termDeadline === undefined ? { graceMs: killGraceMs } : { graceMs: killGraceMs, termDeadline });
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

  return { pid, pgid: pid, stdout, stderr, exited };
}
