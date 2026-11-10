import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { SANDBOX_KILL_GRACE_MS, closeMarkerDescriptor, deadlineSignal, groupSignalsOf, groupTerminationBoundMs, hostProbeTiming, hostProcessGroupPort, signalGroup, terminateGroup } from '@momonga/foundation';
import type { GroupKeeper, KeptExit, ProbeTiming, ProcessGroupPort, TerminateOutcome } from '@momonga/foundation';
import type { SandboxExit, SandboxedProcess } from './types.ts';

export { SANDBOX_KILL_GRACE_MS };

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
  markerFd?: number;
  stdin?: string;
  spawnProcess?: typeof spawn;
  signalTerm?: (pgid: number, stop: AbortSignal) => Promise<void> | void;
  groupPort?: ProcessGroupPort;
  timing?: ProbeTiming;
}

type Child = ReturnType<typeof spawn>;

type Started = { child: Child; keptExit: Promise<KeptExit> | undefined };

const exitCodeOf = (child: Child): Promise<number | undefined> =>
  new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? undefined));
  });

const startKept = (keeper: GroupKeeper, options: LaunchOptions, spawnProcess: typeof spawn, stdinMode: 'ignore' | 'pipe'): Started => {
  if (options.markerFd !== undefined && options.markerFile === undefined) throw new Error(`the marker of ${options.file} reaches a kept command by its path, and only a descriptor was given`);
  const opening = keeper.open({
    command: { file: options.file, args: options.args },
    marker: options.markerFile,
    start: (executable, args) => {
      const child = spawnProcess(executable, [...args], { cwd: options.cwd, env: { ...options.env }, detached: true, windowsHide: true, stdio: [stdinMode, 'pipe', 'pipe'] });
      return { child, pid: child.pid, exited: exitCodeOf(child) };
    },
  });
  return { child: opening.process.child, keptExit: opening.commandExit };
};

const startDirect = (options: LaunchOptions, spawnProcess: typeof spawn, stdinMode: 'ignore' | 'pipe', markerFd: number | undefined): Started => ({
  child: spawnProcess(options.file, [...options.args], {
    cwd: options.cwd,
    env: { ...options.env },
    detached: true,
    windowsHide: true,
    stdio: markerFd === undefined ? [stdinMode, 'pipe', 'pipe'] : [stdinMode, 'pipe', 'pipe', markerFd],
  }),
  keptExit: undefined,
});

export function launch(options: LaunchOptions): SandboxedProcess {
  const spawnProcess = options.spawnProcess ?? spawn;
  const stdinMode = options.stdin === undefined ? 'ignore' : 'pipe';
  const { signal, killGraceMs } = options;
  const timing = options.timing ?? hostProbeTiming;
  const groupPort = options.groupPort ?? hostProcessGroupPort();
  const [firstSignal, ...laterSignals] = groupSignalsOf(groupPort);
  const lastSignal = laterSignals[laterSignals.length - 1];
  const { keeper } = groupPort;
  const markerFd = options.markerFd ?? (options.markerFile === undefined || keeper !== undefined ? undefined : fs.openSync(options.markerFile, 'r'));
  let started: Started;
  try {
    started = keeper === undefined ? startDirect(options, spawnProcess, stdinMode, markerFd) : startKept(keeper, options, spawnProcess, stdinMode);
  } finally {
    if (markerFd !== undefined) {
      if (options.markerFd === undefined) fs.closeSync(markerFd);
      else closeMarkerDescriptor(markerFd);
    }
  }
  const { child, keptExit } = started;
  keptExit?.catch(() => undefined);
  const pid = child.pid;
  if (pid === undefined) {
    child.once('error', () => undefined);
    throw new Error(`failed to spawn ${options.file} in ${options.cwd}`);
  }
  const { stdout, stderr, stdin } = child;
  if (stdout === null || stderr === null) {
    child.once('error', () => undefined);
    signalGroup(pid, lastSignal ?? firstSignal, groupPort, signal).catch((failure: unknown) => {
      process.emitWarning(new Error(`the process group ${pid} could not be killed after its output pipes failed`, { cause: failure }));
    });
    throw new Error(`failed to open output pipes for ${options.file}`);
  }
  const signalTerm = options.signalTerm ?? ((pgid: number, stop: AbortSignal) => signalGroup(pgid, firstSignal, groupPort, stop));
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
  let graceCancelled = false;
  let stopBound: AbortSignal | undefined;
  let stopFailure: unknown;
  let failExited: ((error: unknown) => void) | undefined;

  const reportStopFailure = (failure: unknown): void => {
    stopFailure ??= failure;
  };

  const onAbort = (): void => {
    if (killedBy !== undefined) return;
    killedBy = 'abort';
    termDeadline = timing.now() + killGraceMs;
    const bound = deadlineSignal(timing, groupTerminationBoundMs(killGraceMs));
    stopBound = bound;
    bound.addEventListener(
      'abort',
      () => {
        failExited?.(stopFailure ?? new Error(`process group ${pid} did not stop within ${groupTerminationBoundMs(killGraceMs)} ms of the stop request`));
      },
      { once: true },
    );
    Promise.resolve(signalTerm(pid, bound)).catch(reportStopFailure);
    if (lastSignal === undefined) return;
    void timing.sleep(killGraceMs).then(() => {
      if (graceCancelled) return;
      if (!leaderExited) killedBy = 'grace-kill';
      return signalGroup(pid, lastSignal, groupPort, bound);
    }).catch(reportStopFailure);
  };

  const reapGroup = async (): Promise<TerminateOutcome> => {
    graceCancelled = true;
    const stop = stopBound ?? deadlineSignal(timing, groupTerminationBoundMs(killGraceMs));
    return terminateGroup(pid, {
      graceMs: killGraceMs,
      ...(termDeadline === undefined ? {} : { termDeadline }),
      port: groupPort,
      timing,
      signal: stop,
    });
  };

  let afterExitRan = false;
  const afterExitOnce = (): void => {
    if (afterExitRan) return;
    afterExitRan = true;
    options.afterExit();
  };

  const reapAndClean = async (): Promise<TerminateOutcome | undefined> => {
    const failures: unknown[] = [];
    let outcome: TerminateOutcome | undefined;
    try {
      outcome = await reapGroup();
    } catch (error) {
      failures.push(error);
    }
    try {
      afterExitOnce();
    } catch (error) {
      failures.push(error);
    }
    if (stopFailure !== undefined) failures.push(stopFailure);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'the process group could not be reaped and the cleanup after it failed');
    return outcome;
  };

  let childError: Error | undefined;

  const exited = new Promise<SandboxExit>((resolve, reject) => {
    failExited = reject;
    const failed = (error: Error): void => {
      if (childError !== undefined) return;
      childError = error;
      signal.removeEventListener('abort', onAbort);
      reapAndClean().then(() => reject(error), reject);
    };
    const leaderEnded = (code: number | null, exitSignal: string | null): void => {
      leaderExited = true;
      signal.removeEventListener('abort', onAbort);
      reapAndClean().then((outcome) => {
        if (childError !== undefined) {
          reject(childError);
          return;
        }
        if (stdinFailure !== undefined) {
          reject(stdinFailure);
          return;
        }
        resolve({ code, signal: exitSignal, ...(killedBy === undefined ? {} : { killedBy }), ...(outcome === 'unconfirmed' ? { groupNotStopped: true as const } : {}) });
      }, reject);
    };
    child.once('error', failed);
    if (keptExit === undefined) {
      child.once('exit', leaderEnded);
      return;
    }
    keptExit.then(
      (exit) => (exit.kind === 'exit' ? leaderEnded(exit.code, null) : leaderEnded(null, 'SIGKILL')),
      (error: unknown) => failed(error instanceof Error ? error : new Error(String(error))),
    );
  });

  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();

  return { pid, pgid: pid, stdout, stderr, exited };
}
