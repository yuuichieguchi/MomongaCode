import fs from 'node:fs';
import { systemClock } from '@momonga/foundation';
import { realTimers } from '../process-ports.ts';
import { createUdsClient, isUnixSocketLive, type UdsClient } from '@momonga/foundation';
import type { HealthResult } from '@momonga/protocol';
import { createExecFn, createGroupSpawn, createPlainSpawn, reapStaleFmGroups } from './fm-processes.ts';
import type { ChildEnv } from './fm-processes.ts';
import { PreconditionFailedError } from '../adapters/shared/failures.ts';

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface FmChild {
  finalize?(graceMs: number): Promise<void>;
  kill(signal?: NodeJS.Signals, stop?: AbortSignal): Promise<boolean>;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

export interface ExecOptions {
  signal: AbortSignal;
}

export type ExecFn = (file: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;
export type SpawnFn = (file: string, args: readonly string[]) => FmChild;

export interface FmServeTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface FmServeOptions {
  binary: string;
  socketPath: string;
  healthTimeoutMs: number;
  restartBackoffMs: number;
  stopGraceMs: number;
  maxRestarts: number;
  restartResetMs: number;
  preconditionTtlMs: number;
  env?: ChildEnv;
  markerDirectory?: string;
  onWarning: (message: string) => void;
  exec?: ExecFn;
  spawn?: SpawnFn;
  timers?: FmServeTimers;
}

export interface FmServeEndpoint {
  kind: 'unix';
  socketPath: string;
}

export interface FmServe {
  readonly restarts: number;
  start(signal?: AbortSignal): Promise<FmServeEndpoint>;
  ensureRunning(): Promise<FmServeEndpoint>;
  stop(): Promise<void>;
  health(): Promise<HealthResult>;
}

export type FmServeFailureReason = 'unhealthy' | 'not_running';

export class FmServeError extends Error {
  readonly reason: FmServeFailureReason;
  readonly detail: string | undefined;
  readonly remediation: string | undefined;

  constructor(
    reason: FmServeFailureReason,
    message: string,
    detail: string | undefined,
    remediation: string | undefined,
  ) {
    super(message);
    this.name = 'FmServeError';
    this.reason = reason;
    this.detail = detail;
    this.remediation = remediation;
  }
}

export const PRECONDITION_MESSAGE = 'fm preconditions are not satisfied';
export const LICENSE_NOT_ACCEPTED_EXIT_CODE = 69;
export const LICENSE_REMEDIATION = 'sudo fm license';
const HEALTH_POLL_INTERVAL_MS = 25;

const defaultTimers: FmServeTimers = { ...realTimers, now: () => systemClock.now() };

const CONNECTION_FAILURE_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'ECONNRESET', 'EPIPE']);

const isConnectionFailure = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && (CONNECTION_FAILURE_CODES.has(code) || code.startsWith('UND_ERR'));
};

export const outputOf = (result: ExecResult): string => `${result.stdout}\n${result.stderr}`.trim();

type State = 'idle' | 'starting' | 'running' | 'restarting' | 'failed' | 'precondition_failed' | 'stopped';

interface CachedPreconditions {
  failure: HealthResult | undefined;
  checkedAt: number;
}

interface ManagedChild {
  readonly process: FmChild;
  exited: boolean;
  error: Error | undefined;
  exitWaiters: Array<() => void>;
  terminating: Promise<void> | undefined;
}

const NOT_RUNNING: HealthResult = { ok: false, reason: 'not_running' };

export const createFmServe = (options: FmServeOptions): FmServe => {
  const exec = options.exec ?? createExecFn(options.env);
  const spawn =
    options.spawn ??
    (options.markerDirectory === undefined
      ? createPlainSpawn(options.env)
      : createGroupSpawn({ env: options.env, markerDirectory: options.markerDirectory, onWarning: options.onWarning }));
  const timers = options.timers ?? defaultTimers;
  const argv = ['serve', '--socket', options.socketPath] as const;

  let state: State = 'idle';
  let generation = 0;
  let current: ManagedChild | undefined;
  let client: UdsClient | undefined;
  let startPromise: Promise<FmServeEndpoint> | undefined;
  let endStart: AbortController | undefined;
  let restartRun: Promise<void> | undefined;
  let restartTimer: unknown;
  let totalRestarts = 0;
  let consecutiveFailures = 0;
  let stableTimer: unknown;
  let failure: HealthResult = NOT_RUNNING;
  let preconditionCache: CachedPreconditions | undefined;

  interface WaitDeadline {
    readonly signal: AbortSignal;
    readonly expired: boolean;
    dispose(): void;
  }

  const createDeadline = (ms: number): WaitDeadline => {
    const controller = new AbortController();
    const handle = timers.setTimeout(() => controller.abort(), ms);
    return {
      signal: controller.signal,
      get expired(): boolean {
        return controller.signal.aborted;
      },
      dispose: () => timers.clearTimeout(handle),
    };
  };

  const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const ended = (): void => {
        timers.clearTimeout(handle);
        resolve();
      };
      const handle = timers.setTimeout(() => {
        signal.removeEventListener('abort', ended);
        resolve();
      }, ms);
      signal.addEventListener('abort', ended, { once: true });
    });

  const clearStableTimer = (): void => {
    if (stableTimer !== undefined) {
      timers.clearTimeout(stableTimer);
      stableTimer = undefined;
    }
  };

  type BoundedExec = { kind: 'finished'; result: ExecResult } | { kind: 'expired'; failure: HealthResult };

  const execWithinHealthTimeout = async (args: readonly string[], startSignal: AbortSignal | undefined): Promise<BoundedExec> => {
    const deadline = createDeadline(options.healthTimeoutMs);
    try {
      return { kind: 'finished', result: await exec(options.binary, args, { signal: startSignal === undefined ? deadline.signal : AbortSignal.any([deadline.signal, startSignal]) }) };
    } catch (error) {
      startSignal?.throwIfAborted();
      if (!deadline.expired) throw error;
      return {
        kind: 'expired',
        failure: {
          ok: false,
          reason: 'precondition_failed',
          detail: `fm ${args.join(' ')} did not finish within ${options.healthTimeoutMs} ms`,
        },
      };
    } finally {
      deadline.dispose();
    }
  };

  const runPreconditionChecks = async (startSignal?: AbortSignal): Promise<HealthResult | undefined> => {
    const licenseRun = await execWithinHealthTimeout(['license', '--status'], startSignal);
    if (licenseRun.kind === 'expired') return licenseRun.failure;
    const license = licenseRun.result;
    if (license.exitCode === LICENSE_NOT_ACCEPTED_EXIT_CODE) {
      return {
        ok: false,
        reason: 'precondition_failed',
        detail: outputOf(license),
        remediation: LICENSE_REMEDIATION,
      };
    }
    if (license.exitCode !== 0) {
      return { ok: false, reason: 'precondition_failed', detail: outputOf(license) };
    }
    const availableRun = await execWithinHealthTimeout(['available'], startSignal);
    if (availableRun.kind === 'expired') return availableRun.failure;
    const available = availableRun.result;
    if (available.exitCode !== 0) {
      return { ok: false, reason: 'precondition_failed', detail: outputOf(available) };
    }
    return undefined;
  };

  const checkPreconditions = async (useCache: boolean, startSignal?: AbortSignal): Promise<HealthResult | undefined> => {
    if (useCache && preconditionCache !== undefined) {
      if (timers.now() - preconditionCache.checkedAt < options.preconditionTtlMs) return preconditionCache.failure;
    }
    const result = await runPreconditionChecks(startSignal);
    preconditionCache = { failure: result, checkedAt: timers.now() };
    return result;
  };

  const claimSocketPath = async (): Promise<void> => {
    if (options.markerDirectory !== undefined) {
      await fs.promises.mkdir(options.markerDirectory, { recursive: true, mode: 0o700 });
      await reapStaleFmGroups({ markerDirectory: options.markerDirectory, graceMs: options.stopGraceMs, onWarning: options.onWarning });
    }
    const existing = await fs.promises.lstat(options.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing === undefined) return;
    if (!existing.isSocket()) {
      throw new FmServeError(
        'unhealthy',
        'fm serve socket path is occupied',
        `${options.socketPath} exists and is not a socket`,
        undefined,
      );
    }
    if (await isUnixSocketLive(options.socketPath)) {
      throw new FmServeError(
        'unhealthy',
        'fm serve socket path is occupied',
        `another process owns the socket ${options.socketPath}`,
        undefined,
      );
    }
    await fs.promises.rm(options.socketPath, { force: true });
  };

  const onChildEnd = (managed: ManagedChild, error: Error | undefined): void => {
    if (managed.exited) return;
    managed.exited = true;
    managed.error = error;
    preconditionCache = undefined;
    clearStableTimer();
    const waiters = managed.exitWaiters;
    managed.exitWaiters = [];
    for (const waiter of waiters) waiter();
    if (state === 'running' && current === managed) {
      state = 'restarting';
      scheduleRestart();
    }
  };

  const launch = (): ManagedChild => {
    const managed: ManagedChild = {
      process: spawn(options.binary, argv),
      exited: false,
      error: undefined,
      exitWaiters: [],
      terminating: undefined,
    };
    current = managed;
    managed.process.once('exit', () => onChildEnd(managed, undefined));
    managed.process.once('error', (error) => onChildEnd(managed, error));
    return managed;
  };

  const waitForExit = (managed: ManagedChild, timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (managed.exited) {
        resolve(true);
        return;
      }
      let timer: unknown;
      const waiter = (): void => {
        timers.clearTimeout(timer);
        resolve(true);
      };
      managed.exitWaiters.push(waiter);
      timer = timers.setTimeout(() => {
        managed.exitWaiters = managed.exitWaiters.filter((candidate) => candidate !== waiter);
        resolve(false);
      }, timeoutMs);
    });

  const terminate = (managed: ManagedChild): Promise<void> => {
    managed.terminating ??= (async () => {
      if (!managed.exited) {
        const exitedStop = new AbortController();
        managed.exitWaiters.push(() => exitedStop.abort());
        const sendKill = async (signal: NodeJS.Signals): Promise<void> => {
          try {
            await managed.process.kill(signal, exitedStop.signal);
          } catch (error) {
            if (!exitedStop.signal.aborted) throw error;
          }
        };
        await sendKill('SIGTERM');
        if (!(await waitForExit(managed, options.stopGraceMs))) {
          await sendKill('SIGKILL');
          if (!(await waitForExit(managed, options.stopGraceMs))) {
            options.onWarning(`fm serve was not confirmed stopped: it did not exit within ${options.stopGraceMs} ms after SIGKILL`);
          }
        }
      }
      await managed.process.finalize?.(options.stopGraceMs);
    })();
    return managed.terminating;
  };

  const probeHealth = async (healthClient: UdsClient, signal: AbortSignal): Promise<boolean> => {
    try {
      const response = await healthClient.request({ method: 'GET', path: '/health', signal });
      await response.text();
      return response.status === 200;
    } catch (error) {
      if (isConnectionFailure(error)) return false;
      throw error;
    }
  };

  const waitUntilHealthy = async (managed: ManagedChild, healthClient: UdsClient, startSignal?: AbortSignal): Promise<void> => {
    const deadline = createDeadline(options.healthTimeoutMs);
    const waiting = startSignal === undefined ? deadline.signal : AbortSignal.any([deadline.signal, startSignal]);
    try {
      while (!deadline.expired) {
        startSignal?.throwIfAborted();
        if (managed.exited) {
          if (managed.error !== undefined) {
            throw new FmServeError('not_running', 'fm serve could not be run', managed.error.message, undefined);
          }
          throw new FmServeError('unhealthy', 'fm serve exited before becoming healthy', undefined, undefined);
        }
        if (await probeHealth(healthClient, waiting)) {
          if (!managed.exited) return;
          continue;
        }
        await sleep(HEALTH_POLL_INTERVAL_MS, waiting);
      }
      startSignal?.throwIfAborted();
      throw new FmServeError(
        'unhealthy',
        `fm serve did not become healthy within ${options.healthTimeoutMs} ms`,
        undefined,
        undefined,
      );
    } finally {
      deadline.dispose();
    }
  };

  const closeClient = async (closing: UdsClient): Promise<void> => {
    if (client === closing) client = undefined;
    await closing.close();
  };

  const enterFailed = (reason: 'unhealthy' | 'not_running', detail: string | undefined): void => {
    state = 'failed';
    failure = { ok: false, reason, ...(detail === undefined ? {} : { detail }) };
  };

  const scheduleRestart = (): void => {
    if (consecutiveFailures >= options.maxRestarts) {
      enterFailed('unhealthy', `fm serve exceeded ${options.maxRestarts} restarts`);
      return;
    }
    const delay = options.restartBackoffMs * 2 ** consecutiveFailures;
    const scheduledGeneration = generation;
    restartTimer = timers.setTimeout(() => {
      restartTimer = undefined;
      const run = runRestart(scheduledGeneration);
      restartRun = run;
      void run.then(() => {
        if (restartRun === run) restartRun = undefined;
      });
    }, delay);
  };

  const armStableTimer = (stable: ManagedChild, stableGeneration: number): void => {
    clearStableTimer();
    stableTimer = timers.setTimeout(() => {
      stableTimer = undefined;
      if (current === stable && !stable.exited && generation === stableGeneration) consecutiveFailures = 0;
    }, options.restartResetMs);
  };

  const runRestart = async (restartGeneration: number): Promise<void> => {
    const restartClient = client;
    const ended = new AbortController();
    endStart = ended;
    let launched: ManagedChild | undefined;
    try {
      if (restartClient === undefined) throw new Error('fm serve client is not open');
      const unmet = await checkPreconditions(false, ended.signal);
      if (generation !== restartGeneration) return;
      if (unmet !== undefined) {
        state = 'precondition_failed';
        failure = unmet;
        await closeClient(restartClient);
        return;
      }
      totalRestarts += 1;
      consecutiveFailures += 1;
      await claimSocketPath();
      if (generation !== restartGeneration) return;
      launched = launch();
      await waitUntilHealthy(launched, restartClient, ended.signal);
      if (generation !== restartGeneration) {
        await terminate(launched);
        return;
      }
      state = 'running';
      armStableTimer(launched, restartGeneration);
    } catch (error) {
      if (launched !== undefined) await terminate(launched);
      if (generation !== restartGeneration) return;
      if (error instanceof FmServeError) {
        scheduleRestart();
        if (state === 'failed' && restartClient !== undefined) await closeClient(restartClient);
        return;
      }
      enterFailed('unhealthy', error instanceof Error ? error.message : String(error));
      if (restartClient !== undefined) await closeClient(restartClient);
    } finally {
      if (endStart === ended) endStart = undefined;
    }
  };

  const stoppedDuringStart = (): FmServeError =>
    new FmServeError('not_running', 'fm serve was stopped while starting', undefined, undefined);

  const performStart = async (startGeneration: number, startSignal: AbortSignal): Promise<FmServeEndpoint> => {
    const stale = client;
    if (stale !== undefined) await closeClient(stale);
    const startClient = createUdsClient(options.socketPath);
    client = startClient;
    let launched: ManagedChild | undefined;
    try {
      const unmet = await checkPreconditions(false, startSignal);
      if (generation !== startGeneration) throw stoppedDuringStart();
      if (unmet !== undefined) {
        state = 'precondition_failed';
        failure = unmet;
        throw new PreconditionFailedError(PRECONDITION_MESSAGE, unmet.detail, unmet.remediation);
      }
      await claimSocketPath();
      if (generation !== startGeneration) throw stoppedDuringStart();
      startSignal.throwIfAborted();
      launched = launch();
      await waitUntilHealthy(launched, startClient, startSignal);
      if (generation !== startGeneration) throw stoppedDuringStart();
    } catch (error) {
      if (launched !== undefined) await terminate(launched);
      await closeClient(startClient);
      if (generation !== startGeneration) throw stoppedDuringStart();
      if (error instanceof FmServeError) {
        enterFailed(error.reason, error.detail);
      } else if (!(error instanceof PreconditionFailedError)) {
        state = 'idle';
      }
      throw error;
    }
    state = 'running';
    return { kind: 'unix', socketPath: options.socketPath };
  };

  const begin = (signal: AbortSignal | undefined): Promise<FmServeEndpoint> => {
    state = 'starting';
    generation += 1;
    totalRestarts = 0;
    consecutiveFailures = 0;
    clearStableTimer();
    failure = NOT_RUNNING;
    const ended = new AbortController();
    endStart = ended;
    const started = performStart(generation, signal === undefined ? ended.signal : AbortSignal.any([ended.signal, signal]));
    startPromise = started;
    const clear = (): void => {
      if (startPromise === started) startPromise = undefined;
      if (endStart === ended) endStart = undefined;
    };
    started.then(clear, clear);
    return started;
  };

  const start = (signal?: AbortSignal): Promise<FmServeEndpoint> => {
    if (state === 'starting' && startPromise !== undefined) return startPromise;
    if (state === 'running' || state === 'restarting') return Promise.reject(new Error('fm serve is already started'));
    if (startPromise !== undefined) {
      return startPromise.then(undefined, () => undefined).then(() => begin(signal));
    }
    return begin(signal);
  };

  return {
    get restarts(): number {
      return totalRestarts;
    },

    start,

    ensureRunning(): Promise<FmServeEndpoint> {
      if (state === 'running' || state === 'restarting') {
        return Promise.resolve({ kind: 'unix', socketPath: options.socketPath });
      }
      if (state === 'stopped') {
        return Promise.reject(new FmServeError('not_running', 'fm serve was stopped', undefined, undefined));
      }
      return start();
    },

    async stop(): Promise<void> {
      state = 'stopped';
      generation += 1;
      endStart?.abort(stoppedDuringStart());
      clearStableTimer();
      if (restartTimer !== undefined) {
        timers.clearTimeout(restartTimer);
        restartTimer = undefined;
      }
      const stopping = current;
      const closing = client;
      if (stopping !== undefined) await terminate(stopping);
      const pendingStart = startPromise;
      if (pendingStart !== undefined) await pendingStart.then(undefined, () => undefined);
      const pendingRestart = restartRun;
      if (pendingRestart !== undefined) await pendingRestart;
      if (closing !== undefined) await closeClient(closing);
    },

    async health(): Promise<HealthResult> {
      const unmet = await checkPreconditions(true);
      if (unmet !== undefined) return unmet;
      if (state === 'failed') return failure;
      if (state === 'idle') return { ok: true, detail: 'idle; starts on demand' };
      const healthClient = client;
      if (state !== 'running' || current === undefined || current.exited || healthClient === undefined) return NOT_RUNNING;
      const deadline = createDeadline(options.healthTimeoutMs);
      const healthy = await probeHealth(healthClient, deadline.signal).finally(() => deadline.dispose());
      return healthy ? { ok: true } : { ok: false, reason: 'unhealthy' };
    },
  };
};
