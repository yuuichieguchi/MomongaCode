import type { Duplex, Readable } from 'node:stream';
import type { ResolvedSettings, UserSettingsCache, UserSettingsSnapshot } from '@momonga/config';
import {
  GATEWAY_MAX_CLOSE_MS,
  RUNTIME_ABORT_BUDGET_MS,
  RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS,
  RUNTIME_TEARDOWN_BUDGET_MS,
  SHUTDOWN_MARGIN_MS,
  parseReadyLine,
  runtimeMaxCloseMs,
} from '@momonga/foundation';
import type { Clock, JsonLogger, LockTiming, MomongaPaths, ProcessStartProbe, ReadyFields } from '@momonga/foundation';
import type { SupervisorChildHealth, SupervisorChildState, SupervisorExitReason } from '@momonga/protocol';
import { captureStream, createOutputLimiter } from './capture.ts';
import { definedEnv, gatewayEnv, runtimeEnv, COLLIDING_CREDENTIAL_DETAIL } from './child-env.ts';
import { GATEWAY_ABORT_BUDGET_MS, HELD_REASON_MAX_CHARS, SUPERVISOR_SERVICE } from './constants.ts';
import type { SupervisorIntervals, SupervisorTimers } from './constants.ts';
import { childStdio, resolveLaunch } from './launcher.ts';
import type { GatewayTuning, ChildRole, Launcher, RuntimeTuning } from './launcher.ts';
import {
  childBackoff,
  childError,
  childExit,
  childExternal,
  childHeld,
  childReady,
  childReadyIgnored,
  childReadyMismatch,
  childSpawn,
  childStop,
  childUnkillable,
  settingsReadFailed,
  settingsWarning,
  writeEvent,
} from './log-events.ts';
import type { SupervisorLogEvent } from './log-events.ts';
import { omitUndefined } from './omit-undefined.ts';
import { openDaemonMarker, reapDaemonMarker } from './orphans.ts';
import type { DaemonMarker, MarkerPorts } from './orphans.ts';
import { digestsOf } from './plan.ts';
import type { SettingsDigests } from './plan.ts';
import { watchLock } from './lock-watch.ts';
import type { ExternalProbe, LockWatch } from './lock-watch.ts';
import { classifyExit, decideAfterExit, failureWithoutProcess, stopReasonRank } from './restart-policy.ts';
import type { ExitDecision, RestartPolicy, StopMode, StopReason } from './restart-policy.ts';

export type ChildExit = { code: number | null; signal: NodeJS.Signals | null };

export type SpawnPortOptions = {
  cwd: string;
  env: Readonly<Record<string, string>>;
  detached: true;
  stdio: readonly ['ignore', 'pipe', 'pipe', 'pipe', number];
};

export type ChildHandle = {
  readonly pid: number | undefined;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly lifeline: Duplex | null;
  onSpawnError(listener: (error: NodeJS.ErrnoException) => void): void;
  onExit(listener: (exit: ChildExit) => void): void;
  kill(signal: NodeJS.Signals): void;
  killGroup(): void;
};

export type SpawnPort = (command: string, args: readonly string[], options: SpawnPortOptions) => ChildHandle;

export type ChildState = SupervisorChildState;

export type SpawnReason = 'initial' | 'backoff' | 'lock-free' | 'held-retry' | 'settings-change' | 'plan';

export type HeldSource = 'child-exit' | 'settings';

export type ChildStopResult = { killed: boolean; leaked: boolean };

export type ChildManagerOptions = {
  role: ChildRole;
  home: string;
  paths: MomongaPaths;
  version: string;
  launcher: Launcher;
  env: Readonly<Record<string, string | undefined>>;
  runtime?: RuntimeTuning;
  gateway?: GatewayTuning;
  spawn: SpawnPort;
  settings: UserSettingsCache;
  logger: JsonLogger;
  clock: Clock;
  timers: SupervisorTimers;
  random: () => number;
  restart: RestartPolicy;
  intervals: SupervisorIntervals;
  startupTimeoutMs: number;
  heldRetryMs: number;
  lockWaitMs: number;
  startTimeOf?: ProcessStartProbe;
  lockTiming?: LockTiming;
  markerPorts?: MarkerPorts;
  isDraining(): boolean;
  onBackgroundError(error: unknown, source: string): void;
};

export type ChildManager = {
  readonly role: ChildRole;
  state(): ChildState;
  health(): SupervisorChildHealth;
  isPlanStopped(): boolean;
  appliedDigests(): SettingsDigests | undefined;
  spawnWith(snapshot: UserSettingsSnapshot, reason: SpawnReason): void;
  spawnFresh(reason: SpawnReason): void;
  failWithoutProcess(reason: 'settings-read-failed'): void;
  planStart(): void;
  retryHeld(): void;
  stop(reason: StopReason, mode: StopMode): Promise<ChildStopResult>;
  enterDraining(): void;
  unreapedMarkers(): readonly string[];
  inFlightReaps(): ReadonlyMap<string, Promise<{ removed: boolean }>>;
  awaitLeave(from: ChildState, options: { timeoutMs: number; signal: AbortSignal }): Promise<ChildState>;
};

export const stopBudgetMs = (role: ChildRole, mode: StopMode, drainTimeoutMs: number): number => {
  if (role === 'runtime') {
    return mode === 'term' ? runtimeMaxCloseMs(drainTimeoutMs) + SHUTDOWN_MARGIN_MS : RUNTIME_ABORT_BUDGET_MS + RUNTIME_TEARDOWN_BUDGET_MS + SHUTDOWN_MARGIN_MS;
  }
  return mode === 'term' ? GATEWAY_MAX_CLOSE_MS + SHUTDOWN_MARGIN_MS : GATEWAY_ABORT_BUDGET_MS;
};

type LifeTimerName = 'startup' | 'stable' | 'budget' | 'confirm';

type Life = {
  readonly handle: ChildHandle;
  readonly pid: number | undefined;
  readonly marker: DaemonMarker;
  readonly startedAt: number;
  captures: Promise<void>[];
  lastStderrLine: string | undefined;
  stopReason: StopReason | undefined;
  stopMode: StopMode | undefined;
  stopPromise: Promise<ChildStopResult> | undefined;
  resolveStop: ((result: ChildStopResult) => void) | undefined;
  groupKilled: boolean;
  exited: boolean;
  abandoned: boolean;
  failed: boolean;
  timers: Partial<Record<LifeTimerName, unknown>>;
};

type LastExit = { code: number | null; signal: string | null; at: string; reason: SupervisorExitReason };

type External = { pid?: number; probe: ExternalProbe };

const isStartupReason = (reason: StopReason): boolean => stopReasonRank(reason) === 1;

export const createChildManager = (options: ChildManagerOptions): ChildManager => {
  const { role, timers, clock, logger } = options;
  const drainTimeoutMs = options.runtime?.drainTimeoutMs ?? RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS;

  let state: ChildState = 'pending';
  let generation = 0;
  let launches = 0;
  let consecutiveFailures = 0;
  let planStopped = false;
  let leaked = false;
  let current: Life | undefined;
  let appliedSettings: ResolvedSettings | undefined;
  let lastExit: LastExit | undefined;
  let readyAt: number | undefined;
  let heldReason: string | undefined;
  let lastLoggedHeldReason: string | undefined;
  let nextAttemptAt: number | undefined;
  let external: External | undefined;
  let backoffTimer: unknown;
  let heldTimer: unknown;
  let lockWatch: LockWatch | undefined;
  const unreaped = new Set<string>();
  const inFlightReaps = new Map<string, Promise<{ removed: boolean }>>();
  const leaveWaiters = new Set<{ from: ChildState; settle: () => void }>();
  let lastSkippedNames = '';

  const setState = (next: ChildState): void => {
    state = next;
    for (const waiter of [...leaveWaiters]) if (state !== waiter.from) waiter.settle();
  };

  const isoOf = (ms: number): string => new Date(ms).toISOString();
  const log = (event: SupervisorLogEvent): void => writeEvent(logger, event);

  const schedule = (source: string, ms: number, callback: () => void): unknown =>
    timers.setTimeout(() => {
      try {
        callback();
      } catch (error) {
        options.onBackgroundError(error, source);
      }
    }, ms);

  const clearLifeTimer = (life: Life, name: LifeTimerName): void => {
    const handle = life.timers[name];
    if (handle === undefined) return;
    timers.clearTimeout(handle);
    life.timers[name] = undefined;
  };

  const clearLifeTimers = (life: Life): void => {
    for (const name of ['startup', 'stable', 'budget', 'confirm'] as const) clearLifeTimer(life, name);
  };

  const clearScheduled = (): void => {
    if (backoffTimer !== undefined) timers.clearTimeout(backoffTimer);
    if (heldTimer !== undefined) timers.clearTimeout(heldTimer);
    backoffTimer = undefined;
    heldTimer = undefined;
    lockWatch?.stop();
    lockWatch = undefined;
    nextAttemptAt = undefined;
    external = undefined;
  };

  const beginAttempt = (): void => {
    clearScheduled();
    generation += 1;
    planStopped = false;
    leaked = false;
  };

  const liveLife = (): Life | undefined => (current !== undefined && !current.abandoned && !current.failed ? current : undefined);

  const settleStop = (life: Life, result: ChildStopResult): void => {
    const resolve = life.resolveStop;
    life.resolveStop = undefined;
    resolve?.(result);
  };

  const destroyStreams = (life: Life): void => {
    life.handle.stdout.destroy();
    life.handle.stderr.destroy();
    life.handle.lifeline?.destroy();
  };

  const armHeldRetry = (): void => {
    const armedGeneration = generation;
    heldTimer = schedule('held-retry-timer', options.heldRetryMs, () => {
      heldTimer = undefined;
      if (options.isDraining() || generation !== armedGeneration) return;
      spawnFresh('held-retry');
    });
  };

  const hold = (reason: string, source: HeldSource): void => {
    setState('held-config');
    heldReason = reason;
    if (reason !== lastLoggedHeldReason) {
      lastLoggedHeldReason = reason;
      log(childHeld({ child: role, heldReason: reason, source }));
    }
    armHeldRetry();
  };

  const enterBackoff = (delayMs: number): void => {
    setState('backoff');
    consecutiveFailures += 1;
    nextAttemptAt = clock.now() + delayMs;
    const armedGeneration = generation;
    backoffTimer = schedule('backoff-timer', delayMs, () => {
      backoffTimer = undefined;
      if (options.isDraining() || generation !== armedGeneration) return;
      spawnFresh('backoff');
    });
    log(childBackoff({ child: role, delayMs, consecutiveFailures }));
  };

  const enterWaitingLock = (): void => {
    setState('waiting-lock');
    const armedGeneration = generation;
    const isStale = (): boolean => options.isDraining() || generation !== armedGeneration;
    lockWatch = watchLock({
      role,
      lockPath: options.paths.locks[role],
      socketPath: options.paths.sockets[role],
      lockWaitMs: options.lockWaitMs,
      lockPollMs: options.intervals.lockPollMs,
      externalPollMs: options.intervals.externalPollMs,
      timers,
      ...omitUndefined({ startTimeOf: options.startTimeOf, timing: options.lockTiming }),
      onFree: () => {
        if (isStale()) return;
        spawnFresh('lock-free');
      },
      onExternal: (holderPid) => {
        if (isStale()) return;
        setState('external');
        external = { ...(holderPid === undefined ? {} : { pid: holderPid }), probe: 'pending' };
        log(childExternal({ child: role, holderPid: holderPid ?? null }));
      },
      onProbe: (probe) => {
        if (isStale() || external === undefined) return;
        external = { ...external, probe };
      },
      onBackgroundError: options.onBackgroundError,
    });
  };

  const heldReasonFor = (stderrLine: string | undefined): string =>
    stderrLine === undefined ? `child exited 78 (see ${role}.log)` : `child exited 78: ${stderrLine.slice(0, HELD_REASON_MAX_CHARS)}`;

  const applyDecision = (decision: ExitDecision, stderrLine: string | undefined): void => {
    switch (decision.next) {
      case 'stopped':
        setState('stopped');
        return;
      case 'plan-stopped':
        setState('stopped');
        planStopped = true;
        return;
      case 'backoff':
        enterBackoff(decision.delayMs);
        return;
      case 'waiting-lock':
        enterWaitingLock();
        return;
      case 'held-config':
        hold(heldReasonFor(stderrLine), 'child-exit');
        return;
    }
  };

  const reportSkippedNames = (names: readonly string[]): void => {
    const key = [...names].sort().join('\n');
    if (key === lastSkippedNames) return;
    lastSkippedNames = key;
    for (const name of names) log(settingsWarning({ detail: `${name}: ${COLLIDING_CREDENTIAL_DETAIL}` }));
  };

  const recordFailureWithoutProcess = (reason: 'spawn-failed' | 'settings-read-failed', stopReason?: StopReason): void => {
    lastExit = { code: null, signal: null, at: isoOf(clock.now()), reason };
    readyAt = undefined;
    if (options.isDraining()) {
      setState('stopped');
      return;
    }
    if (stopReason === undefined) {
      applyDecision(decideAfterExit({ exit: failureWithoutProcess(reason), consecutiveFailures, policy: options.restart, random: options.random }), undefined);
      return;
    }
    applyDecision(
      decideAfterExit({ exit: classifyExit({ code: null, signal: null, stop: stopReason }), consecutiveFailures, policy: options.restart, random: options.random }),
      undefined,
    );
  };

  const failWithoutProcess = (reason: 'spawn-failed' | 'settings-read-failed', error: unknown, stopReason?: StopReason): void => {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (reason === 'spawn-failed') {
      log(childExit({ child: role, childPid: null, code: null, signal: null, reason, restarts: Math.max(0, launches - 1) }, failure));
    } else {
      log(settingsReadFailed({ detail: failure.message }, failure));
    }
    recordFailureWithoutProcess(reason, stopReason);
  };

  const spawnProcess = (snapshot: Extract<UserSettingsSnapshot, { settings: unknown }>): { marker: DaemonMarker; handle: ChildHandle } => {
    const skippedNames: string[] = [];
    const resolved = resolveLaunch({
      role,
      launcher: options.launcher,
      version: options.version,
      home: options.home,
      ...omitUndefined({ runtime: options.runtime, gateway: options.gateway }),
      baseEnv: definedEnv(options.env),
      separateEnv: (merged) =>
        role === 'gateway'
          ? gatewayEnv(merged, snapshot.settings, options.home, (name) => skippedNames.push(name))
          : runtimeEnv(merged, snapshot.settings).env,
    });
    if (role === 'gateway') reportSkippedNames(skippedNames);
    const marker = openDaemonMarker(options.paths.markers.daemons, role);
    try {
      const handle = options.spawn(resolved.command, resolved.args, { cwd: options.home, env: resolved.env, detached: true, stdio: childStdio(marker.fd) });
      return { marker, handle };
    } catch (error) {
      marker.closeFd();
      marker.remove();
      throw error;
    }
  };

  const becomeReady = (life: Life, fields: ReadyFields): void => {
    clearLifeTimer(life, 'startup');
    setState('ready');
    readyAt = clock.now();
    heldReason = undefined;
    lastLoggedHeldReason = undefined;
    life.timers.stable = schedule('stable-timer', options.restart.stableAfterMs, () => {
      life.timers.stable = undefined;
      if (current === life && state === 'ready') consecutiveFailures = 0;
    });
    log(childReady({ child: role, childPid: fields.pid, version: fields.version, socketPath: fields.socketPath, startedAt: fields.startedAt }));
  };

  const consumeStdout = (life: Life, line: string): boolean => {
    if (current !== life) return false;
    if (state === 'stopping') {
      if (parseReadyLine(line) === undefined) return false;
      log(childReadyIgnored({ child: role, childPid: life.pid ?? null }));
      return true;
    }
    if (state !== 'starting') return false;
    const fields = parseReadyLine(line);
    if (fields === undefined) return false;
    if (fields.service === role && fields.pid === life.pid) {
      becomeReady(life, fields);
      return true;
    }
    log(childReadyMismatch({ child: role, childPid: life.pid ?? null, readyService: fields.service, readyPid: fields.pid }));
    void stop('ready-mismatch', 'term');
    return true;
  };

  const startCaptures = (life: Life, pid: number): void => {
    const limiter = createOutputLimiter({ role, childPid: pid, clock, logger });
    const report = (error: unknown): void => options.onBackgroundError(error, 'capture');
    life.captures = [
      captureStream({ stream: life.handle.stdout, kind: 'stdout', role, childPid: pid, service: SUPERVISOR_SERVICE, logger, limiter, consume: (line) => consumeStdout(life, line) }).catch(report),
      captureStream({
        stream: life.handle.stderr,
        kind: 'stderr',
        role,
        childPid: pid,
        service: SUPERVISOR_SERVICE,
        logger,
        limiter,
        consume: (line) => {
          life.lastStderrLine = line;
          return false;
        },
      }).catch(report),
    ];
  };

  const failLifeWithoutProcess = (life: Life, error: NodeJS.ErrnoException): void => {
    life.failed = true;
    clearLifeTimers(life);
    destroyStreams(life);
    life.marker.remove();
    if (current === life) current = undefined;
    failWithoutProcess('spawn-failed', error, life.stopReason);
    settleStop(life, { killed: false, leaked: false });
  };

  const onHandleError = (life: Life, error: NodeJS.ErrnoException): void => {
    if (life.pid === undefined && !life.exited && !life.failed && current === life) {
      failLifeWithoutProcess(life, error);
      return;
    }
    log(childError({ child: role, childPid: life.pid ?? null }, error));
  };

  const flushStdio = async (life: Life): Promise<void> => {
    const ended = Promise.all(life.captures);
    let flushTimer: unknown;
    const timedOut = new Promise<'timeout'>((resolve) => {
      flushTimer = timers.setTimeout(() => resolve('timeout'), options.intervals.stdioFlushMs);
    });
    const outcome = await Promise.race([ended.then(() => 'ended' as const), timedOut]);
    timers.clearTimeout(flushTimer);
    destroyStreams(life);
    if (outcome === 'timeout') await ended;
  };

  const reapMarker = async (markerPath: string): Promise<void> => {
    unreaped.add(markerPath);
    const reaping = reapDaemonMarker({ marker: markerPath, logger, ...omitUndefined({ markerPorts: options.markerPorts }) });
    inFlightReaps.set(markerPath, reaping);
    try {
      const result = await reaping;
      if (result.removed) unreaped.delete(markerPath);
    } finally {
      inFlightReaps.delete(markerPath);
    }
  };

  const handleExit = async (life: Life, exit: ChildExit): Promise<void> => {
    life.exited = true;
    clearLifeTimers(life);
    if (life.abandoned) {
      await flushStdio(life);
      return;
    }
    const arrivalGeneration = generation;
    await flushStdio(life);
    if (options.isDraining()) unreaped.add(life.marker.path);
    else await reapMarker(life.marker.path);
    const draining = options.isDraining();
    if (!draining && generation !== arrivalGeneration) {
      settleStop(life, { killed: life.groupKilled, leaked: false });
      if (current === life) current = undefined;
      return;
    }
    const classification = classifyExit({ code: exit.code, signal: exit.signal, stop: life.stopReason });
    lastExit = { code: exit.code, signal: exit.signal, at: isoOf(clock.now()), reason: classification.reason };
    readyAt = undefined;
    if (current === life) current = undefined;
    log(
      childExit({
        child: role,
        childPid: life.pid ?? null,
        code: exit.code,
        signal: exit.signal,
        reason: classification.reason,
        restarts: Math.max(0, launches - 1),
      }),
    );
    settleStop(life, { killed: life.groupKilled, leaked: false });
    if (draining) {
      setState('stopped');
      return;
    }
    applyDecision(decideAfterExit({ exit: classification, consecutiveFailures, policy: options.restart, random: options.random }), life.lastStderrLine);
  };

  const onHandleExit = (life: Life, exit: ChildExit): void => {
    if (life.failed) return;
    handleExit(life, exit).catch((error: unknown) => options.onBackgroundError(error, 'exit-handler'));
  };

  const launch = (snapshot: UserSettingsSnapshot, reason: SpawnReason): void => {
    if (options.isDraining()) return;
    beginAttempt();
    if ('error' in snapshot) {
      hold(snapshot.error.message, 'settings');
      return;
    }
    launches += 1;
    appliedSettings = snapshot.settings;
    heldReason = undefined;
    readyAt = undefined;
    let started: { marker: DaemonMarker; handle: ChildHandle };
    try {
      started = spawnProcess(snapshot);
    } catch (error) {
      failWithoutProcess('spawn-failed', error);
      return;
    }
    const { marker, handle } = started;
    marker.closeFd();
    const life: Life = {
      handle,
      pid: handle.pid,
      marker,
      startedAt: clock.now(),
      captures: [],
      lastStderrLine: undefined,
      stopReason: undefined,
      stopMode: undefined,
      stopPromise: undefined,
      resolveStop: undefined,
      groupKilled: false,
      exited: false,
      abandoned: false,
      failed: false,
      timers: {},
    };
    current = life;
    setState('starting');
    handle.onSpawnError((error) => onHandleError(life, error));
    handle.onExit((exit) => onHandleExit(life, exit));
    if (handle.pid !== undefined) startCaptures(life, handle.pid);
    life.timers.startup = schedule('startup-timer', options.startupTimeoutMs, () => {
      life.timers.startup = undefined;
      if (current === life && state === 'starting') void stop('startup-timeout', 'term');
    });
    log(childSpawn({ child: role, childPid: handle.pid ?? null, restarts: Math.max(0, launches - 1), reason }));
  };

  function spawnFresh(reason: SpawnReason): void {
    if (options.isDraining()) return;
    let snapshot: UserSettingsSnapshot;
    try {
      snapshot = options.settings.snapshot();
    } catch (error) {
      beginAttempt();
      failWithoutProcess('settings-read-failed', error);
      return;
    }
    launch(snapshot, reason);
  }

  const declareUnkillable = (life: Life): void => {
    if (life.exited) return;
    life.abandoned = true;
    generation += 1;
    leaked = true;
    setState('stopped');
    planStopped = life.stopReason === 'plan-restart';
    unreaped.add(life.marker.path);
    log(childUnkillable({ child: role, childPid: life.pid ?? null }));
    settleStop(life, { killed: true, leaked: true });
  };

  const armBudget = (life: Life, ms: number): void => {
    clearLifeTimer(life, 'budget');
    life.timers.budget = schedule('stop-budget-timer', ms, () => {
      life.timers.budget = undefined;
      if (life.exited) return;
      life.groupKilled = true;
      life.handle.killGroup();
      life.timers.confirm = schedule('kill-confirm-timer', options.intervals.killConfirmMs, () => {
        life.timers.confirm = undefined;
        declareUnkillable(life);
      });
    });
  };

  const budgetFor = (reason: StopReason, mode: StopMode): number =>
    isStartupReason(reason) && mode === 'term' ? options.restart.startupKillGraceMs : stopBudgetMs(role, mode, drainTimeoutMs);

  const stopWithoutProcess = (reason: StopReason): ChildStopResult => {
    if (reason !== 'plan-restart') {
      clearScheduled();
      if (state !== 'stopped') {
        generation += 1;
        setState('stopped');
      }
      planStopped = false;
    }
    return { killed: false, leaked };
  };

  function stop(reason: StopReason, mode: StopMode): Promise<ChildStopResult> {
    const life = liveLife();
    if (life === undefined) return Promise.resolve(stopWithoutProcess(reason));
    if (life.exited) return Promise.resolve({ killed: life.groupKilled, leaked: false });
    if (life.stopReason !== undefined) {
      const recorded = life.stopReason;
      if (stopReasonRank(reason) > stopReasonRank(recorded)) {
        life.stopReason = reason;
        log(childStop({ child: role, childPid: life.pid ?? null, stop: reason, mode, superseded: recorded }));
      }
      if (mode === 'int' && life.stopMode === 'term' && life.pid !== undefined) {
        life.stopMode = 'int';
        life.handle.kill('SIGINT');
        if (!life.groupKilled) armBudget(life, budgetFor(life.stopReason, 'int'));
      }
      return life.stopPromise as Promise<ChildStopResult>;
    }
    life.stopReason = reason;
    life.stopMode = mode;
    life.stopPromise = new Promise<ChildStopResult>((resolve) => {
      life.resolveStop = resolve;
    });
    clearLifeTimer(life, 'startup');
    clearLifeTimer(life, 'stable');
    setState('stopping');
    log(childStop({ child: role, childPid: life.pid ?? null, stop: reason, mode }));
    generation += 1;
    if (life.pid !== undefined) {
      life.handle.kill(mode === 'int' ? 'SIGINT' : 'SIGTERM');
      armBudget(life, budgetFor(reason, mode));
    }
    return life.stopPromise;
  }

  const enterDraining = (): void => {
    clearScheduled();
    generation += 1;
    if (liveLife() === undefined) setState('stopped');
  };

  const awaitLeave = (from: ChildState, leaveOptions: { timeoutMs: number; signal: AbortSignal }): Promise<ChildState> =>
    new Promise<ChildState>((resolve) => {
      if (state !== from || leaveOptions.signal.aborted) {
        resolve(state);
        return;
      }
      const waiter = { from, settle: (): void => undefined };
      const limitTimer = timers.setTimeout(() => waiter.settle(), leaveOptions.timeoutMs);
      const settle = (): void => {
        leaveWaiters.delete(waiter);
        timers.clearTimeout(limitTimer);
        leaveOptions.signal.removeEventListener('abort', settle);
        resolve(state);
      };
      waiter.settle = settle;
      leaveWaiters.add(waiter);
      leaveOptions.signal.addEventListener('abort', settle, { once: true });
    });

  const health = (): SupervisorChildHealth => ({
    role,
    state,
    restarts: Math.max(0, launches - 1),
    consecutiveFailures,
    ...omitUndefined({
      pid: current?.pid,
      startedAt: current === undefined ? undefined : isoOf(current.startedAt),
      readyAt: readyAt === undefined ? undefined : isoOf(readyAt),
      nextAttemptAt: nextAttemptAt === undefined ? undefined : isoOf(nextAttemptAt),
      lastExit,
      heldReason,
      external,
    }),
  });

  return {
    role,
    state: () => state,
    health,
    isPlanStopped: () => planStopped,
    appliedDigests: (): SettingsDigests | undefined => (appliedSettings === undefined ? undefined : digestsOf(appliedSettings)),
    spawnWith: launch,
    spawnFresh,
    failWithoutProcess: (reason) => {
      beginAttempt();
      recordFailureWithoutProcess(reason);
    },
    planStart: () => {
      if (options.isDraining() || !planStopped) return;
      spawnFresh('plan');
    },
    retryHeld: () => {
      if (options.isDraining() || state !== 'held-config') return;
      consecutiveFailures = 0;
      spawnFresh('settings-change');
    },
    stop,
    enterDraining,
    unreapedMarkers: () => [...unreaped],
    inFlightReaps: () => inFlightReaps,
    awaitLeave,
  };
};
