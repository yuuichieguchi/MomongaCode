import fs from 'node:fs';
import path from 'node:path';
import { KILL_CONFIRM_MS, ProcessLockHeldError, acquireProcessLock, createUdsClient, fixedSocket, isPipePath, isUnixSocketLive, socketBindRefusalOf, startSharedCall, systemClock } from '@momonga/foundation';
import type { GenerationRole, ProcessLock, SharedCall, UdsClient, ProcessInspector, KernelLockMechanism } from '@momonga/foundation';
import { SOCKET_PLACEHOLDER, WORDS, messageOf } from '@momonga/protocol';
import type { HealthResult, ManagedEndpointForm, ManagedServerDescription } from '@momonga/protocol';
import { realTimers } from '../process-ports.ts';
import { PreconditionFailedError, TargetNotReadyError } from '../adapters/shared/failures.ts';
import { createExecFn, createGroupSpawn, reapStaleGroups } from './fm-processes.ts';
import type { ChildEnv } from './fm-processes.ts';
import { aboutModel } from './name.ts';
import { notReadyText, runPreconditions } from './preconditions.ts';
import type { ExecFn, RefusedVerdict } from './preconditions.ts';

export interface ManagedChild {
  finalize?(graceMs: number): Promise<void>;
  kill(signal?: NodeJS.Signals, stop?: AbortSignal): Promise<boolean>;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

export type SpawnFn = (file: string, args: readonly string[]) => ManagedChild;

export interface ManagedServerTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export type ManagedServerOptions = {
  description: ManagedServerDescription;
  target: string;
  binary: string;
  socketPath: string;
  lockPath: string;
  lock: KernelLockMechanism;
  inspector: ProcessInspector;
  markerDirectory?: string;
  readyTimeoutMs: number;
  env?: ChildEnv;
  exec?: ExecFn;
  spawn?: SpawnFn;
  timers?: ManagedServerTimers;
  readStopGraceMs: () => number;
  onWarning: (message: string) => void;
  onChildStart?: (signal: AbortSignal) => Promise<void>;
  onChildExit?: () => void;
  role?: { current(): GenerationRole };
};

export interface ManagedEndpoint {
  kind: ManagedEndpointForm;
  path: string;
}

export interface ManagedServer {
  readonly restarts: number;
  start(signal?: AbortSignal): Promise<ManagedEndpoint>;
  ensureRunning(signal?: AbortSignal): Promise<ManagedEndpoint>;
  stop(stop?: { stopGraceMs: number }): Promise<void>;
  health(signal: AbortSignal): Promise<HealthResult>;
}

export type ManagedServerFailureReason = 'unhealthy' | 'not_running';

export class ManagedServerError extends Error {
  readonly reason: ManagedServerFailureReason;
  readonly detail: string | undefined;

  constructor(reason: ManagedServerFailureReason, message: string, detail: string | undefined) {
    super(message);
    this.name = 'ManagedServerError';
    this.reason = reason;
    this.detail = detail;
  }
}

export const HEALTH_POLL_INTERVAL_MS = 25;

export const MANAGED_SERVER_BEHAVIOUR = {
  reapOnStart: true,
  boundedRetries: true,
  cacheRefusal: false,
  resetOnReady: false,
  claimBounded: true,
  singleFlight: 'key',
  instanceWait: true,
} as const;

const LOCK_DIRECTORY_MODE = 0o700;

const defaultTimers: ManagedServerTimers = { ...realTimers, now: () => systemClock.now() };

const CONNECTION_FAILURE_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'ECONNRESET', 'EPIPE']);

const isConnectionFailure = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && (CONNECTION_FAILURE_CODES.has(code) || code.startsWith('UND_ERR'));
};

type State = 'idle' | 'starting' | 'running' | 'restarting' | 'failed' | 'precondition_failed' | 'stopped';

interface RunningChild {
  readonly process: ManagedChild;
  exited: boolean;
  error: Error | undefined;
  exitWaiters: Array<() => void>;
  terminating: Promise<void> | undefined;
}

const NOT_RUNNING: HealthResult = { ok: false, reason: 'not_running' };

const IDLE: HealthResult = { ok: true, detail: 'idle; starts on demand' };

const argvOf = (description: ManagedServerDescription, socketPath: string): string[] => description.launch.argv.map((part) => (part === SOCKET_PLACEHOLDER ? socketPath : part));

const refusalHealth = (refusal: RefusedVerdict): HealthResult => ({
  ok: false,
  reason: 'precondition_failed',
  detail: refusal.detail,
  ...(refusal.remedy === undefined ? {} : { remediation: refusal.remedy }),
});

const NEVER_ENDED = new AbortController().signal;

export const createManagedServer = (options: ManagedServerOptions): ManagedServer => {
  const { description, target } = options;
  const exec = options.exec ?? createExecFn(options.env);
  const spawn =
    options.spawn ??
    (options.markerDirectory === undefined
      ? (): ManagedChild => {
          throw new Error(aboutModel(target, 'the server has no marker directory, so it cannot be launched'));
        }
      : createGroupSpawn({ env: options.env, markerDirectory: options.markerDirectory, onWarning: options.onWarning, inspector: options.inspector }));
  const timers = options.timers ?? defaultTimers;
  const argv = argvOf(description, options.socketPath);
  const said = (text: string): string => aboutModel(target, text);

  let state: State = 'idle';
  let generation = 0;
  let current: RunningChild | undefined;
  let client: UdsClient | undefined;
  let startFlight: SharedCall<ManagedEndpoint> | undefined;
  let endStart: AbortController | undefined;
  let restartRun: Promise<void> | undefined;
  let restartTimer: unknown;
  let totalRestarts = 0;
  let consecutiveFailures = 0;
  let windowTimer: unknown;
  let failure: HealthResult = NOT_RUNNING;
  let metVerdict = false;

  type Deadline = { readonly signal: AbortSignal; readonly expired: boolean; dispose(): void };

  const createDeadline = (ms: number): Deadline => {
    const controller = new AbortController();
    const handle = timers.setTimeout(() => controller.abort(new ManagedServerError('unhealthy', said(`the ${WORDS.server} was not ready within ${ms} ms of its start; readyTimeoutMs of the ${WORDS.model} in the settings sets this bound`), undefined)), ms);
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

  const clearWindowTimer = (): void => {
    if (windowTimer !== undefined) {
      timers.clearTimeout(windowTimer);
      windowTimer = undefined;
    }
  };

  const checkPreconditions = async (signal: AbortSignal): Promise<RefusedVerdict | undefined> => {
    if (metVerdict) return undefined;
    const verdict = await runPreconditions(description, options.binary, exec, signal);
    if (verdict.kind === 'refused') return verdict;
    metVerdict = true;
    return undefined;
  };

  const endpoint: ManagedEndpoint = { kind: isPipePath(options.socketPath) ? 'pipe' : 'unix', path: options.socketPath };

  const unfitSocketError = async (): Promise<TargetNotReadyError | undefined> => {
    if (endpoint.kind !== 'unix') return undefined;
    await fs.promises.mkdir(path.dirname(options.socketPath), { recursive: true, mode: LOCK_DIRECTORY_MODE });
    const refusal = await socketBindRefusalOf(options.socketPath);
    if (refusal === undefined) return undefined;
    return new TargetNotReadyError(
      refusal.kind === 'unsupported'
        ? messageOf('serverSocketPathTooLong', 'gateway', { model: target, byteLength: refusal.byteLength, directory: refusal.directory, code: refusal.code })
        : said(`a socket path of ${refusal.byteLength} bytes could not be tested in ${refusal.directory}: ${refusal.reason}`),
    );
  };

  const occupied = (detail: string): ManagedServerError => new ManagedServerError('unhealthy', said('the server socket path is occupied'), detail);

  const acquireInstanceLock = async (signal: AbortSignal): Promise<ProcessLock> => {
    await fs.promises.mkdir(path.dirname(options.lockPath), { recursive: true, mode: LOCK_DIRECTORY_MODE });
    for (;;) {
      signal.throwIfAborted();
      try {
        return await acquireProcessLock(options.lockPath, undefined, { mechanism: options.lock });
      } catch (error) {
        if (!(error instanceof ProcessLockHeldError)) throw error;
      }
      await sleep(HEALTH_POLL_INTERVAL_MS, signal);
    }
  };

  const waitForFreeSocket = async (signal: AbortSignal): Promise<void> => {
    for (;;) {
      signal.throwIfAborted();
      const existing = await fs.promises.lstat(options.socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (existing === undefined) return;
      if (!existing.isSocket()) throw occupied(`${options.socketPath} exists and is not a socket`);
      if (!(await isUnixSocketLive(options.socketPath, signal))) {
        await fs.promises.rm(options.socketPath, { force: true });
        return;
      }
      await sleep(HEALTH_POLL_INTERVAL_MS, signal);
    }
  };

  const claimInstance = async (signal: AbortSignal): Promise<ProcessLock> => {
    const lock = await acquireInstanceLock(signal);
    try {
      if (options.markerDirectory !== undefined) {
        await fs.promises.mkdir(options.markerDirectory, { recursive: true, mode: LOCK_DIRECTORY_MODE });
        await reapStaleGroups({ markerDirectory: options.markerDirectory, graceMs: options.readStopGraceMs(), onWarning: options.onWarning, signal, inspector: options.inspector });
      }
      await waitForFreeSocket(signal);
      return lock;
    } catch (error) {
      lock.release();
      throw error;
    }
  };

  const onChildEnd = (managed: RunningChild, error: Error | undefined): void => {
    if (managed.exited) return;
    managed.exited = true;
    managed.error = error;
    metVerdict = false;
    clearWindowTimer();
    const waiters = managed.exitWaiters;
    managed.exitWaiters = [];
    for (const waiter of waiters) waiter();
    options.onChildExit?.();
    if (state === 'running' && current === managed) {
      state = 'restarting';
      scheduleRestart();
    }
  };

  const launch = (): RunningChild => {
    const managed: RunningChild = { process: spawn(options.binary, argv), exited: false, error: undefined, exitWaiters: [], terminating: undefined };
    current = managed;
    managed.process.once('exit', () => onChildEnd(managed, undefined));
    managed.process.once('error', (error) => onChildEnd(managed, error));
    return managed;
  };

  const waitForExit = (managed: RunningChild, timeoutMs: number): Promise<boolean> =>
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

  const terminate = (managed: RunningChild, givenGraceMs?: number): Promise<void> => {
    managed.terminating ??= (async () => {
      const graceMs = givenGraceMs ?? options.readStopGraceMs();
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
        if (!(await waitForExit(managed, graceMs))) {
          await sendKill('SIGKILL');
          if (!(await waitForExit(managed, KILL_CONFIRM_MS))) {
            options.onWarning(said(`the server process was not confirmed stopped: it did not exit within ${KILL_CONFIRM_MS} ms after SIGKILL`));
          }
        }
      }
      await managed.process.finalize?.(graceMs);
    })();
    return managed.terminating;
  };

  const answersReady = async (readyClient: UdsClient, signal: AbortSignal): Promise<boolean> => {
    try {
      const response = await readyClient.request({ method: description.ready.method, path: description.ready.path, signal });
      await response.text();
      return response.status === description.ready.status;
    } catch (error) {
      if (isConnectionFailure(error)) return false;
      throw error;
    }
  };

  const waitUntilReady = async (managed: RunningChild, readyClient: UdsClient, signal: AbortSignal): Promise<void> => {
    for (;;) {
      signal.throwIfAborted();
      if (managed.exited) {
        if (managed.error !== undefined) throw new ManagedServerError('not_running', said(`the server could not be run: ${managed.error.message}`), managed.error.message);
        throw new ManagedServerError('unhealthy', said('the server exited before it was ready'), undefined);
      }
      if ((await answersReady(readyClient, signal)) && !managed.exited) return;
      await sleep(HEALTH_POLL_INTERVAL_MS, signal);
    }
  };

  const closeClient = async (closing: UdsClient): Promise<void> => {
    if (client === closing) client = undefined;
    await closing.close();
  };

  const enterFailed = (reason: ManagedServerFailureReason, detail: string | undefined): void => {
    state = 'failed';
    failure = { ok: false, reason, ...(detail === undefined ? {} : { detail }) };
  };

  const restartsOnlyForCalls = (): boolean => options.role?.current() === 'retiring';

  const scheduleRestart = (): void => {
    if (restartsOnlyForCalls()) {
      state = 'idle';
      return;
    }
    if (consecutiveFailures >= description.restart.maxRestarts) {
      enterFailed('unhealthy', said(`the server exceeded ${description.restart.maxRestarts} restarts; the next request starts it again`));
      return;
    }
    const delay = description.restart.backoffMs * 2 ** consecutiveFailures;
    const scheduledGeneration = generation;
    restartTimer = timers.setTimeout(() => {
      restartTimer = undefined;
      if (restartsOnlyForCalls()) {
        if (generation === scheduledGeneration) state = 'idle';
        return;
      }
      const run = runRestart(scheduledGeneration);
      restartRun = run;
      void run.then(() => {
        if (restartRun === run) restartRun = undefined;
      });
    }, delay);
  };

  const armWindowTimer = (stable: RunningChild, stableGeneration: number): void => {
    clearWindowTimer();
    windowTimer = timers.setTimeout(() => {
      windowTimer = undefined;
      if (current === stable && !stable.exited && generation === stableGeneration) consecutiveFailures = 0;
    }, description.restart.windowMs);
  };

  const launchReady = async (startClient: UdsClient, signal: AbortSignal, isCurrent: () => boolean): Promise<RunningChild | undefined> => {
    const lock = await claimInstance(signal);
    let launched: RunningChild | undefined;
    let childStartBegun = false;
    try {
      if (!isCurrent()) return undefined;
      signal.throwIfAborted();
      childStartBegun = true;
      await options.onChildStart?.(signal);
      if (!isCurrent()) return undefined;
      launched = launch();
      await waitUntilReady(launched, startClient, signal);
      return launched;
    } catch (error) {
      if (launched !== undefined) await terminate(launched);
      throw error;
    } finally {
      if (childStartBegun && launched === undefined) options.onChildExit?.();
      lock.release();
    }
  };

  const runRestart = async (restartGeneration: number): Promise<void> => {
    const restartClient = client;
    const ended = new AbortController();
    endStart = ended;
    const deadline = createDeadline(options.readyTimeoutMs);
    const signal = AbortSignal.any([ended.signal, deadline.signal]);
    const isCurrent = (): boolean => generation === restartGeneration;
    try {
      if (restartClient === undefined) throw new Error(said('the server client is not open'));
      const refusal = await checkPreconditions(signal);
      if (!isCurrent()) return;
      if (refusal !== undefined) {
        state = 'precondition_failed';
        failure = refusalHealth(refusal);
        await closeClient(restartClient);
        return;
      }
      totalRestarts += 1;
      consecutiveFailures += 1;
      const launched = await launchReady(restartClient, signal, isCurrent);
      if (launched === undefined) return;
      if (!isCurrent()) {
        await terminate(launched);
        return;
      }
      state = 'running';
      armWindowTimer(launched, restartGeneration);
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ManagedServerError) {
        scheduleRestart();
        if (state === 'failed' && restartClient !== undefined) await closeClient(restartClient);
        return;
      }
      enterFailed('unhealthy', error instanceof Error ? error.message : String(error));
      if (restartClient !== undefined) await closeClient(restartClient);
    } finally {
      deadline.dispose();
      if (endStart === ended) endStart = undefined;
    }
  };

  const stoppedDuringStart = (): ManagedServerError => new ManagedServerError('not_running', said('the server was stopped while starting'), undefined);

  const performStart = async (startGeneration: number, startSignal: AbortSignal): Promise<ManagedEndpoint> => {
    const stale = client;
    if (stale !== undefined) await closeClient(stale);
    const startClient = createUdsClient(fixedSocket(options.socketPath), { connectTimeoutMs: 0 });
    client = startClient;
    const isCurrent = (): boolean => generation === startGeneration;
    try {
      const unfit = await unfitSocketError();
      if (unfit !== undefined) {
        state = 'precondition_failed';
        failure = { ok: false, reason: 'precondition_failed', detail: unfit.message };
        throw unfit;
      }
      const refusal = await checkPreconditions(startSignal);
      if (!isCurrent()) throw stoppedDuringStart();
      if (refusal !== undefined) {
        state = 'precondition_failed';
        failure = refusalHealth(refusal);
        throw new PreconditionFailedError(notReadyText(target, refusal.message), refusal.detail, refusal.remedy);
      }
      const deadline = createDeadline(options.readyTimeoutMs);
      try {
        const launched = await launchReady(startClient, AbortSignal.any([startSignal, deadline.signal]), isCurrent);
        if (launched === undefined || !isCurrent()) throw stoppedDuringStart();
      } finally {
        deadline.dispose();
      }
    } catch (error) {
      await closeClient(startClient);
      if (!isCurrent()) throw stoppedDuringStart();
      if (error instanceof ManagedServerError) enterFailed(error.reason, error.detail ?? error.message);
      else if (!(error instanceof PreconditionFailedError) && !(error instanceof TargetNotReadyError)) state = 'idle';
      throw error;
    }
    state = 'running';
    return endpoint;
  };

  const begin = (): SharedCall<ManagedEndpoint> => {
    state = 'starting';
    generation += 1;
    totalRestarts = 0;
    consecutiveFailures = 0;
    metVerdict = false;
    clearWindowTimer();
    failure = NOT_RUNNING;
    const ended = new AbortController();
    endStart = ended;
    const startGeneration = generation;
    const started = startSharedCall(
      ended.signal,
      (shared) => performStart(startGeneration, shared),
      () => undefined,
    );
    startFlight = started;
    const clear = (): void => {
      if (startFlight === started) startFlight = undefined;
      if (endStart === ended) endStart = undefined;
    };
    started.work.then(clear, clear);
    return started;
  };

  const start = (signal: AbortSignal = NEVER_ENDED): Promise<ManagedEndpoint> => {
    if (state === 'starting' && startFlight !== undefined) return startFlight.join(signal);
    if (state === 'running' || state === 'restarting') return Promise.reject(new Error(said('the server is already started')));
    if (startFlight !== undefined) return startFlight.work.then(undefined, () => undefined).then(() => start(signal));
    return begin().join(signal);
  };

  return {
    get restarts(): number {
      return totalRestarts;
    },

    start,

    ensureRunning(signal?: AbortSignal): Promise<ManagedEndpoint> {
      if (state === 'running' || state === 'restarting') return Promise.resolve(endpoint);
      if (state === 'stopped') return Promise.reject(new ManagedServerError('not_running', said('the server was stopped'), undefined));
      return start(signal);
    },

    async stop(stop): Promise<void> {
      state = 'stopped';
      generation += 1;
      metVerdict = false;
      endStart?.abort(stoppedDuringStart());
      clearWindowTimer();
      if (restartTimer !== undefined) {
        timers.clearTimeout(restartTimer);
        restartTimer = undefined;
      }
      const stopping = current;
      const closing = client;
      if (stopping !== undefined) await terminate(stopping, stop?.stopGraceMs);
      const pendingStart = startFlight;
      if (pendingStart !== undefined) await pendingStart.work.then(undefined, () => undefined);
      const pendingRestart = restartRun;
      if (pendingRestart !== undefined) await pendingRestart;
      if (closing !== undefined) await closeClient(closing);
    },

    async health(signal: AbortSignal): Promise<HealthResult> {
      const refusal = await checkPreconditions(signal);
      if (refusal !== undefined) return refusalHealth(refusal);
      if (state === 'failed') return failure;
      if (state === 'idle') return IDLE;
      const healthClient = client;
      if (state !== 'running' || current === undefined || current.exited || healthClient === undefined) return NOT_RUNNING;
      return (await answersReady(healthClient, signal)) ? { ok: true } : { ok: false, reason: 'unhealthy' };
    },
  };
};
