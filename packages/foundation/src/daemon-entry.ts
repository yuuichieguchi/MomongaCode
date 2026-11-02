import os from 'node:os';
import { systemClock } from './clock.ts';
import type { Clock } from './clock.ts';
import { EntryUsageError, parseFlags } from './entry-flags.ts';
import type { FlagSpec, ParsedFlags } from './entry-flags.ts';
import { watchLifeline } from './lifeline.ts';
import { ENTRY_HARD_EXIT_MARGIN_MS, EXIT_ALREADY_RUNNING, EXIT_CONFIG, EXIT_FAILURE, EXIT_OK, STDIO_EXIT_FLUSH_MS, createJsonLogger } from './process-contract.ts';
import type { JsonLogger, TextStream } from './process-contract.ts';
import { ProcessLockHeldError, UnadoptedEnv, acquireProcessLock } from './process-lock.ts';
import type { DescribeHolder, ProcessLock } from './process-lock.ts';
import type { KernelLockMechanism } from './platform/kernel-lock.ts';
import { LOG_KEEP, LOG_MAX_BYTES, createRotatingLogFile } from './rotating-log.ts';
import type { RotatingLogFile } from './rotating-log.ts';

export type EntrySignal = 'SIGTERM' | 'SIGINT';

export type LogTarget = 'file' | 'stderr' | 'both';

export type EntryIo = {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  stdout: TextStream;
  stderr: TextStream;
  clock: Clock;
  timers: { setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  onSignal(signal: EntrySignal, handler: () => void): () => void;
  onUncaught(handler: (error: Error) => void): () => void;
  watchLifeline(fd: number, onEnd: () => void): () => void;
  logFile(path: string): RotatingLogFile;
  holdOpen(): () => void;
  lockMechanism?: KernelLockMechanism;
  exit(code: number): void;
};

export type DaemonCloseResult = { clean: boolean };

export type DaemonHandle = {
  close(): Promise<DaemonCloseResult>;
  abort(): Promise<DaemonCloseResult>;
  fatal: Promise<Error>;
};

export type DaemonStartContext<F extends FlagSpec> = {
  version: string;
  flags: ParsedFlags<F>;
  home: string;
  env: EntryIo['env'];
  signal: AbortSignal;
  logger: JsonLogger;
  stdout: TextStream;
  droppedLogLines(): number;
  requestShutdown(): void;
  acquireLock(lockPath: string, describeHolder?: DescribeHolder): Promise<ProcessLock>;
};

export type DaemonDefinition<F extends FlagSpec> = {
  service: 'runtime' | 'gateway' | 'supervisor';
  version: string;
  flags: F;
  maxCloseMs(flags: ParsedFlags<F>): number;
  ownLockPath(home: string): string;
  logPath(home: string): string;
  isConfigError(error: unknown): boolean;
  start(context: DaemonStartContext<F>): Promise<DaemonHandle>;
};

export class StartupCancelled extends Error {
  constructor(message = 'startup cancelled') {
    super(message);
    this.name = 'StartupCancelled';
  }
}

type ShutdownTrigger = 'sigterm' | 'sigint' | 'lifeline' | 'request' | 'fatal' | 'uncaught';

type ExitPath = 'close' | 'abort' | 'deadline' | 'startup-cancelled' | 'start-failed';

type Phase = 'starting' | 'running' | 'closing' | 'aborting' | 'closed';

const LOG_TARGETS: readonly LogTarget[] = ['file', 'stderr', 'both'];
const WRITE_FAILURE_INTERVAL_MS = 60_000;
const HOLD_OPEN_INTERVAL_MS = 3_600_000;

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

export const exitCodeForStartError = (input: { error: unknown; ownLockPath: string; isConfigError(error: unknown): boolean }): number => {
  const { error, ownLockPath, isConfigError } = input;
  if (error instanceof EntryUsageError || isConfigError(error)) return EXIT_CONFIG;
  if (error instanceof ProcessLockHeldError && error.lockPath === ownLockPath) return EXIT_ALREADY_RUNNING;
  return EXIT_FAILURE;
};

const commonFlagsOf = (flags: Readonly<Record<string, unknown>>): { home: string | undefined; lifelineFd: number | undefined; logTarget: string | undefined } => {
  const { home, 'lifeline-fd': lifelineFd, 'log-target': logTarget } = flags;
  return {
    home: typeof home === 'string' ? home : undefined,
    lifelineFd: typeof lifelineFd === 'number' ? lifelineFd : undefined,
    logTarget: typeof logTarget === 'string' ? logTarget : undefined,
  };
};

const parseLogTarget = (value: string | undefined): LogTarget => {
  if (value === undefined) return 'both';
  const target = LOG_TARGETS.find((candidate) => candidate === value);
  if (target === undefined) throw new EntryUsageError(`--log-target must be one of ${LOG_TARGETS.join(', ')}, got ${value}`);
  return target;
};

const triggerForSignal = (signal: EntrySignal): ShutdownTrigger => (signal === 'SIGTERM' ? 'sigterm' : 'sigint');

type ResolvedEntry<F extends FlagSpec> = {
  flags: ParsedFlags<F>;
  home: string;
  logPath: string;
  ownLockPath: string;
  logTarget: LogTarget;
  lifelineFd: number | undefined;
};

const resolveEntry = <F extends FlagSpec>(io: EntryIo, definition: DaemonDefinition<F>): ResolvedEntry<F> => {
  const flags = parseFlags(io.argv, definition.flags);
  const common = commonFlagsOf(flags);
  const home = common.home ?? io.home;
  const logTarget = parseLogTarget(common.logTarget);
  return { flags, home, logPath: definition.logPath(home), ownLockPath: definition.ownLockPath(home), logTarget, lifelineFd: common.lifelineFd };
};

const reportUsageError = (io: EntryIo, service: string, error: unknown): number => {
  createJsonLogger({ service, clock: io.clock, stream: io.stderr }).error('entry.usage_error', { err: toError(error) });
  io.exit(EXIT_CONFIG);
  return EXIT_CONFIG;
};

type LogSink = { logger: JsonLogger; effectiveTarget: LogTarget; droppedLogLines(): number; close(): void };

const openLogSink = (io: EntryIo, service: string, logPath: string, requested: LogTarget): LogSink => {
  let file: RotatingLogFile | undefined;
  let effectiveTarget = requested;
  const diagnostics = createJsonLogger({ service, clock: io.clock, stream: io.stderr });
  if (requested !== 'stderr') {
    try {
      file = io.logFile(logPath);
    } catch (error) {
      diagnostics.error('entry.log_sink_failed', { err: toError(error) });
      effectiveTarget = 'stderr';
    }
  }
  const toStderr = effectiveTarget !== 'file';
  const stream: TextStream = {
    write: (chunk) => {
      file?.write(chunk);
      if (toStderr) io.stderr.write(chunk);
      return true;
    },
  };
  return {
    logger: createJsonLogger({ service, clock: io.clock, stream }),
    effectiveTarget,
    droppedLogLines: () => file?.droppedLines ?? 0,
    close: () => file?.close(),
  };
};

export const runDaemonEntry = async <F extends FlagSpec>(io: EntryIo, definition: DaemonDefinition<F>): Promise<number> => {
  const releaseHold = io.holdOpen();
  let resolved: ResolvedEntry<F>;
  try {
    resolved = resolveEntry(io, definition);
  } catch (error) {
    releaseHold();
    return reportUsageError(io, definition.service, error);
  }
  const { flags, home, ownLockPath, logTarget, lifelineFd } = resolved;
  const sink = openLogSink(io, definition.service, resolved.logPath, logTarget);
  const { logger } = sink;
  const controller = new AbortController();
  const outcome = Promise.withResolvers<number>();

  let phase: Phase = 'starting';
  let handle: DaemonHandle | undefined;
  let shutdownTrigger: ShutdownTrigger | undefined;
  let failureForced = false;
  let deadlineTimer: unknown;
  let suppressedUncaught = 0;
  let uncaughtLogged = false;
  const disposers: Array<() => void> = [releaseHold];

  const isClosed = (): boolean => phase === 'closed';

  const finish = (code: number, exitPath: ExitPath): void => {
    if (phase === 'closed') return;
    phase = 'closed';
    if (deadlineTimer !== undefined) io.timers.clearTimeout(deadlineTimer);
    logger.info('entry.exit', {
      data: { code, path: exitPath, clean: code === EXIT_OK, ...(shutdownTrigger === undefined ? {} : { trigger: shutdownTrigger }), suppressedUncaught },
    });
    sink.close();
    for (const dispose of disposers) dispose();
    io.exit(code);
    outcome.resolve(code);
  };

  const beginShutdown = (trigger: ShutdownTrigger): void => {
    if (shutdownTrigger !== undefined) return;
    shutdownTrigger = trigger;
    deadlineTimer = io.timers.setTimeout(() => finish(EXIT_FAILURE, 'deadline'), definition.maxCloseMs(flags) + ENTRY_HARD_EXIT_MARGIN_MS);
  };

  const settleShutdown = (result: DaemonCloseResult | Error, method: 'close' | 'abort'): void => {
    if (result instanceof Error) logger.error('entry.shutdown_failed', { err: result });
    const clean = !(result instanceof Error) && result.clean;
    finish(clean && !failureForced ? EXIT_OK : EXIT_FAILURE, method);
  };

  const invocations: Array<{ method: 'close' | 'abort'; pending: Promise<DaemonCloseResult> }> = [];

  const methodProducing = (pending: Promise<DaemonCloseResult>): 'close' | 'abort' => {
    const invocation = invocations.findLast((candidate) => candidate.pending === pending);
    if (invocation === undefined) throw new Error('shutdown settled for a promise no invocation produced');
    return invocation.method;
  };

  const invoke = (target: DaemonHandle, method: 'close' | 'abort'): void => {
    let pending: Promise<DaemonCloseResult>;
    try {
      pending = target[method]();
    } catch (error) {
      pending = Promise.reject(error);
    }
    invocations.push({ method, pending });
    void pending.then(
      (result) => settleShutdown(result, methodProducing(pending)),
      (error: unknown) => settleShutdown(toError(error), methodProducing(pending)),
    );
  };

  const close = (target: DaemonHandle): void => {
    phase = 'closing';
    invoke(target, 'close');
  };

  const abort = (target: DaemonHandle): void => {
    phase = 'aborting';
    invoke(target, 'abort');
  };

  const latchCancel = (trigger: ShutdownTrigger): void => {
    const first = shutdownTrigger === undefined;
    beginShutdown(trigger);
    if (first) controller.abort(new StartupCancelled());
  };

  const onSignal = (signal: EntrySignal): void => {
    if (phase === 'closed') return;
    logger.info('entry.signal', { data: { signal, state: phase } });
    const trigger = triggerForSignal(signal);
    if (phase === 'starting') latchCancel(trigger);
    else if (handle === undefined) return;
    else if (phase === 'running') {
      beginShutdown(trigger);
      if (signal === 'SIGTERM') close(handle);
      else abort(handle);
    } else if (phase === 'closing') abort(handle);
  };

  const onLifelineEnd = (): void => {
    if (phase === 'closed') return;
    logger.info('entry.lifeline_eof');
    if (phase === 'starting') latchCancel('lifeline');
    else if (phase === 'running' && handle !== undefined) {
      beginShutdown('lifeline');
      close(handle);
    }
  };

  const onFatal = (error: Error): void => {
    if (phase === 'closed') return;
    logger.error('entry.fatal', { err: error });
    failureForced = true;
    if (handle === undefined || phase === 'aborting') return;
    beginShutdown('fatal');
    abort(handle);
  };

  const onUncaught = (error: Error): void => {
    if (phase === 'closed') return;
    if (!uncaughtLogged) {
      uncaughtLogged = true;
      logger.error('entry.uncaught', { err: error });
    } else {
      suppressedUncaught += 1;
      if (suppressedUncaught === 1) logger.error('entry.uncaught_suppressed');
    }
    failureForced = true;
    if (phase === 'starting') latchCancel('uncaught');
    else if (handle !== undefined && phase !== 'aborting') {
      beginShutdown('uncaught');
      abort(handle);
    }
  };

  const requestShutdown = (): void => {
    if (phase === 'closed') return;
    logger.info('entry.shutdown_requested', { data: { state: phase } });
    if (phase === 'starting') latchCancel('request');
    else if (phase === 'running' && handle !== undefined) {
      beginShutdown('request');
      close(handle);
    }
  };

  disposers.push(io.onSignal('SIGTERM', () => onSignal('SIGTERM')));
  disposers.push(io.onSignal('SIGINT', () => onSignal('SIGINT')));
  disposers.push(io.onUncaught(onUncaught));
  logger.info('entry.start', { data: { logTarget: sink.effectiveTarget, lifeline: lifelineFd !== undefined } });

  try {
    if (lifelineFd !== undefined) disposers.push(io.watchLifeline(lifelineFd, onLifelineEnd));
  } catch (error) {
    logger.error('entry.start_failed', { err: toError(error) });
    finish(exitCodeForStartError({ error, ownLockPath, isConfigError: definition.isConfigError }), 'start-failed');
    return outcome.promise;
  }

  let started: DaemonHandle;
  try {
    const unadopted = new UnadoptedEnv(io.env);
    const acquireLock = async (lockPath: string, describeHolder?: DescribeHolder): Promise<ProcessLock> =>
      unadopted.handedOff
        ? unadopted.adopt(lockPath)
        : acquireProcessLock(lockPath, describeHolder, io.lockMechanism === undefined ? {} : { mechanism: io.lockMechanism });
    started = await definition.start({
      version: definition.version,
      flags,
      home,
      env: unadopted.withoutLockVariables(),
      signal: controller.signal,
      logger,
      stdout: io.stdout,
      droppedLogLines: sink.droppedLogLines,
      requestShutdown,
      acquireLock,
    });
  } catch (error) {
    if (shutdownTrigger !== undefined) {
      logger.warn('entry.startup_cancelled', { err: toError(error) });
      finish(EXIT_FAILURE, 'startup-cancelled');
    } else {
      logger.error('entry.start_failed', { err: toError(error) });
      finish(exitCodeForStartError({ error, ownLockPath, isConfigError: definition.isConfigError }), 'start-failed');
    }
    return outcome.promise;
  }
  if (isClosed()) return outcome.promise;
  handle = started;
  void started.fatal.then(onFatal, (error: unknown) => onUncaught(toError(error)));
  if (shutdownTrigger === undefined) phase = 'running';
  else close(started);
  return outcome.promise;
};

const noop = (): void => undefined;

const flushed = (stream: NodeJS.WriteStream): Promise<void> =>
  new Promise<void>((resolve) => {
    stream.write('', () => resolve());
  });

export const nodeEntryIo = (host: NodeJS.Process = process): EntryIo => {
  host.stdout.on('error', noop);
  host.stderr.on('error', noop);
  let lastWriteFailureAt: number | undefined;
  const reportWriteFailure = (error: Error): void => {
    const now = Date.now();
    if (lastWriteFailureAt !== undefined && now - lastWriteFailureAt < WRITE_FAILURE_INTERVAL_MS) return;
    lastWriteFailureAt = now;
    host.stderr.write(`${JSON.stringify({ ts: new Date(now).toISOString(), level: 'error', pid: host.pid, msg: 'logs.write_failed', err: { name: error.name, message: error.message } })}\n`);
  };
  return {
    argv: host.argv.slice(2),
    env: host.env,
    home: host.env['HOME'] ?? os.homedir(),
    stdout: host.stdout,
    stderr: host.stderr,
    clock: systemClock,
    timers: { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) },
    onSignal: (signal, handler) => {
      host.on(signal, handler);
      return () => {
        host.off(signal, handler);
      };
    },
    onUncaught: (handler) => {
      const onException = (error: Error): void => handler(error);
      const onRejection = (reason: unknown): void => handler(toError(reason));
      host.on('uncaughtException', onException);
      host.on('unhandledRejection', onRejection);
      return () => {
        host.off('uncaughtException', onException);
        host.off('unhandledRejection', onRejection);
      };
    },
    watchLifeline,
    holdOpen: () => {
      const hold = setInterval(noop, HOLD_OPEN_INTERVAL_MS);
      return () => clearInterval(hold);
    },
    logFile: (path) => createRotatingLogFile({ path, maxBytes: LOG_MAX_BYTES, keep: LOG_KEEP, mode: 0o600, onWriteFailure: reportWriteFailure }),
    exit: (code) => {
      host.exitCode = code;
      const timeout = Promise.withResolvers<void>();
      const timer = setTimeout(timeout.resolve, STDIO_EXIT_FLUSH_MS);
      void Promise.race([Promise.all([flushed(host.stdout), flushed(host.stderr)]), timeout.promise]).then(() => {
        clearTimeout(timer);
        host.exit(code);
      });
    },
  };
};
