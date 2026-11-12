import type { spawn } from 'node:child_process';
import { Deadline, SANDBOX_KILL_GRACE_MS, closeMarkerDescriptor, groupSignalsOf, groupTerminationBoundMs, hostProcessGroupPort, launchGroupLeader, signalGroup, sleep, systemTiming, systemWaitTiming, terminateGroup } from '@momonga/foundation';
import type { GroupLaunch, GroupLaunchMarker, LaunchProtection, LaunchSlot, ProcessGroupPort, TerminateOutcome, Timing } from '@momonga/foundation';
import type { Duplex } from 'node:stream';
import type { SandboxExit, SandboxedProcess } from './types.ts';

export { SANDBOX_KILL_GRACE_MS };

export const MARKER_SLOT = 3;

export const SOCKET_FILTER_SLOT = 4;

const STDIO_THROUGH_SOCKET_FILTER = ['ignore', 'pipe'] as const;

const ENDED_BEFORE_READING: ReadonlySet<string> = new Set(['EPIPE', 'ECONNRESET']);

export const SANDBOX_STOP_BOUND_MS = groupTerminationBoundMs(SANDBOX_KILL_GRACE_MS);

export interface LaunchOptions {
  file: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  signal: AbortSignal;
  killGraceMs: number;
  afterExit: () => void | Promise<void>;
  protection: LaunchProtection;
  markerFile?: string;
  markerFd?: number;
  stdin?: string;
  socketFilter?: Uint8Array;
  channel?: { slot: number; serve: (stream: Duplex) => void };
  spawnProcess?: typeof spawn;
  signalTerm?: (pgid: number, stop: AbortSignal) => Promise<void> | void;
  groupPort?: ProcessGroupPort;
  timing?: Timing;
}

const stdioOf = (stdinMode: 'ignore' | 'pipe', options: LaunchOptions): LaunchSlot[] => {
  const slots: LaunchSlot[] = [stdinMode, 'pipe', 'pipe', ...(options.socketFilter === undefined ? [] : STDIO_THROUGH_SOCKET_FILTER)];
  if (options.channel === undefined) return slots;
  while (slots.length < options.channel.slot) slots.push('ignore');
  slots[options.channel.slot] = 'pipe';
  return slots;
};

export function launch(options: LaunchOptions): SandboxedProcess {
  const stdinMode = options.stdin === undefined ? 'ignore' : 'pipe';
  const { killGraceMs } = options;
  let signal = options.signal;
  const timing = options.timing ?? systemWaitTiming;
  const stopBoundOf = (ms: number): AbortSignal => Deadline.after(ms, options.timing ?? systemTiming).signal;
  const groupPort = options.groupPort ?? hostProcessGroupPort();
  const [firstSignal, ...laterSignals] = groupSignalsOf(groupPort);
  const lastSignal = laterSignals[laterSignals.length - 1];
  const marker: GroupLaunchMarker | undefined =
    options.markerFile !== undefined
      ? { slot: MARKER_SLOT, file: options.markerFile, ...(options.markerFd === undefined ? {} : { descriptor: options.markerFd }) }
      : options.markerFd === undefined
        ? undefined
        : { slot: MARKER_SLOT, descriptor: options.markerFd };
  let launched: GroupLaunch;
  try {
    launched = launchGroupLeader({
      file: options.file,
      args: options.args,
      protection: options.protection,
      cwd: options.cwd,
      env: options.env,
      stdio: stdioOf(stdinMode, options),
      ...(marker === undefined ? {} : { marker }),
      port: groupPort,
      ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
    });
  } finally {
    if (options.markerFd !== undefined) closeMarkerDescriptor(options.markerFd);
  }
  const { child } = launched;
  const pid = launched.pgid;
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
  const fed = (error: NodeJS.ErrnoException): void => {
    if (error.code !== 'EPIPE') stdinFailure ??= error;
  };
  if (options.stdin !== undefined && stdin !== null) {
    stdin.on('error', fed);
    stdin.end(options.stdin);
  }
  if (options.socketFilter !== undefined) {
    const feed = child.stdio[SOCKET_FILTER_SLOT];
    if (feed === null || feed === undefined || !('end' in feed)) {
      child.once('error', () => undefined);
      signalGroup(pid, lastSignal ?? firstSignal, groupPort, signal).catch((failure: unknown) => {
        process.emitWarning(new Error(`the process group ${pid} could not be killed after the pipe of its socket filter failed`, { cause: failure }));
      });
      throw new Error(`failed to open the pipe of the socket filter for ${options.file}`);
    }
    feed.on('error', (error: NodeJS.ErrnoException) => {
      if (!ENDED_BEFORE_READING.has(error.code ?? '')) stdinFailure ??= error;
    });
    feed.end(options.socketFilter);
  }
  if (options.channel !== undefined) {
    const stream = child.stdio[options.channel.slot];
    if (stream === null || stream === undefined || !('end' in stream) || !('read' in stream)) {
      child.once('error', () => undefined);
      signalGroup(pid, lastSignal ?? firstSignal, groupPort, signal).catch((failure: unknown) => {
        process.emitWarning(new Error(`the process group ${pid} could not be killed after its network relay channel failed to open`, { cause: failure }));
      });
      throw new Error(`failed to open the network relay channel for ${options.file}`);
    }
    options.channel.serve(stream as Duplex);
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
    termDeadline = timing.monotonicMs() + killGraceMs;
    const bound = stopBoundOf(groupTerminationBoundMs(killGraceMs));
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
    void sleep(timing, killGraceMs).then(() => {
      if (graceCancelled) return;
      if (!leaderExited) killedBy = 'grace-kill';
      return signalGroup(pid, lastSignal, groupPort, bound);
    }).catch(reportStopFailure);
  };

  const reapGroup = async (): Promise<TerminateOutcome> => {
    graceCancelled = true;
    const stop = stopBound ?? stopBoundOf(groupTerminationBoundMs(killGraceMs));
    return terminateGroup(pid, {
      graceMs: killGraceMs,
      ...(termDeadline === undefined ? {} : { termDeadline }),
      port: groupPort,
      timing,
      signal: stop,
    });
  };

  let afterExitRan = false;
  const afterExitOnce = async (): Promise<void> => {
    if (afterExitRan) return;
    afterExitRan = true;
    await options.afterExit();
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
      await afterExitOnce();
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
        resolve({ code, signal: exitSignal, ...(killedBy === undefined ? {} : { killedBy }), stop: outcome === 'unconfirmed' ? 'not_confirmed' : 'confirmed' });
      }, reject);
    };
    child.once('error', failed);
    launched.onExit(({ code, signal: exitSignal }) => leaderEnded(code, exitSignal), failed);
  });

  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();

  const rebind = (next: AbortSignal): void => {
    signal.removeEventListener('abort', onAbort);
    signal = next;
    if (leaderExited || childError !== undefined) return;
    next.addEventListener('abort', onAbort, { once: true });
    if (next.aborted) onAbort();
  };

  return { pid, pgid: pid, stdout, stderr, exited, rebind };
}
