import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Duplex, Readable } from 'node:stream';
import { createStopValuesReader } from '@momonga/config';
import type { StopValuesReader, UserSettingsCache, UserSettingsSnapshot } from '@momonga/config';
import {
  claimLockForChild,
  formatStopMessage,
  gatewayAbortBudgetMs,
  gatewayStopBudgetMs,
  managedServerReapBoundMs,
  parseReadyLine,
  reapMarkerDirectory,
  runtimeAbortStopBudgetMs,
  runtimeStopBudgetMs,
  CREDENTIAL_CAPABILITY_ENV,
  SETTINGS_APPLIED_ENV,
  generationLayout,
} from '@momonga/foundation';
import type { Clock, JsonLogger, KernelLockMechanism, LockHandoff, LockHandoffClaim, MomongaPaths, ReadyFields, RoleEndpoint, StopValues } from '@momonga/foundation';
import type { SupervisorChildHealth, SupervisorChildState, SupervisorExitReason } from '@momonga/protocol';
import { captureStream, createOutputLimiter } from './capture.ts';
import { definedEnv, gatewayEnv, runtimeEnv, COLLIDING_CREDENTIAL_DETAIL } from './child-env.ts';
import { HELD_REASON_MAX_CHARS, SUPERVISOR_SERVICE } from './constants.ts';
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
  childVersionMismatch,
  childStop,
  childUnkillable,
  orphansWarning,
  settingsReadFailed,
  settingsWarning,
  writeEvent,
} from './log-events.ts';
import type { SupervisorLogEvent } from './log-events.ts';
import { omitUndefined } from './omit-undefined.ts';
import { openDaemonMarker, reapDaemonMarker } from './orphans.ts';
import type { DaemonMarker, MarkerPorts } from './orphans.ts';
import { watchLock } from './lock-watch.ts';
import type { ExternalProbe, LockWatch } from './lock-watch.ts';
import { classifyExit, decideAfterExit, failureWithoutProcess, stopReasonRank, stopsAStart } from './restart-policy.ts';
import type { ExitClassification, ExitDecision, RestartPolicy, StopMode, StopReason } from './restart-policy.ts';

export type ChildExit = { code: number | null; signal: NodeJS.Signals | null };

export type SpawnPortOptions = {
  cwd: string;
  env: Readonly<Record<string, string>>;
  detached: true;
  markerFile?: string;
  stdio: readonly ['ignore', 'pipe', 'pipe', 'pipe', number] | readonly ['ignore', 'pipe', 'pipe', 'pipe', number, number];
};

export type ChildHandle = {
  readonly pid: number | undefined;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly lifeline: Duplex | null;
  onSpawnError(listener: (error: NodeJS.ErrnoException) => void): void;
  onExit(listener: (exit: ChildExit) => void): void;
  kill(signal: NodeJS.Signals): void;
  killGroup(stop?: AbortSignal): Promise<void>;
};

export type SpawnPort = (command: string, args: readonly string[], options: SpawnPortOptions) => ChildHandle;

export type ChildState = SupervisorChildState;

const CAPABILITY_BYTES = 32;

export type SpawnReason = 'initial' | 'backoff' | 'lock-free' | 'held-retry' | 'settings-change';

export type HeldSource = 'child-exit' | 'settings';

export type ChildStopResult = { killed: boolean; leaked: boolean };

export type ChildVersionMismatch = { role: ChildRole; childVersion: string };

export type ChildManagerOptions = {
  role: ChildRole;
  version: string;
  home: string;
  paths: MomongaPaths;
  generation: number;
  endpoint: RoleEndpoint;
  launcher: Launcher;
  env: Readonly<Record<string, string | undefined>>;
  runtime?: RuntimeTuning;
  gateway?: GatewayTuning;
  spawn: SpawnPort;
  settings: UserSettingsCache;
  signal: AbortSignal;
  logger: JsonLogger;
  clock: Clock;
  timers: SupervisorTimers;
  random: () => number;
  restart: RestartPolicy;
  intervals: SupervisorIntervals;
  startupTimeoutMs: number;
  heldRetryMs: number;
  lockWaitMs: number;
  lockMechanism?: KernelLockMechanism;
  markerPorts?: MarkerPorts;
  stopValues?: StopValuesReader;
  isDraining(): boolean;
  isRetiring(): boolean;
  onRetiredExit(): void;
  onBackgroundError(error: unknown, source: string): void;
  onTransientError(error: unknown, source: string): void;
  onVersionMismatch(mismatch: ChildVersionMismatch): void;
  onReady(): void;
};

export type ChildManager = {
  readonly role: ChildRole;
  state(): ChildState;
  health(): SupervisorChildHealth;
  spawnWith(snapshot: UserSettingsSnapshot, reason: SpawnReason): void;
  spawnFresh(reason: SpawnReason): void;
  failWithoutProcess(reason: 'settings-read-failed'): void;
  retryHeld(): void;
  holdsCapability(given: string): boolean;
  stop(reason: StopReason, mode: StopMode, values?: StopValues): Promise<ChildStopResult>;
  enterDraining(): void;
  enterRetiring(): void;
  hasEnded(): boolean;
  unreapedMarkers(): readonly string[];
  inFlightReaps(): ReadonlyMap<string, Promise<{ removed: boolean }>>;
  awaitLeave(from: ChildState, options: { timeoutMs: number; signal: AbortSignal }): Promise<ChildState>;
};

export const stopBudgetMs = (role: ChildRole, mode: StopMode, values: StopValues): number => {
  if (role === 'runtime') return mode === 'term' ? runtimeStopBudgetMs(values) : runtimeAbortStopBudgetMs(values);
  return mode === 'term' ? gatewayStopBudgetMs(values) : gatewayAbortBudgetMs(values);
};

const runsManagedServers = (role: ChildRole): boolean => role === 'gateway';

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
  stopValues: StopValues | undefined;
  signalled: boolean;
  budgetEndsAt: number | undefined;
  stopPromise: Promise<ChildStopResult> | undefined;
  resolveStop: ((result: ChildStopResult) => void) | undefined;
  groupKilled: boolean;
  killStop: AbortController;
  exited: boolean;
  abandoned: boolean;
  failed: boolean;
  capability: string | undefined;
  timers: Partial<Record<LifeTimerName, unknown>>;
};

type LastExit = { code: number | null; signal: string | null; at: string; reason: SupervisorExitReason };

type External = { pid?: number; probe: ExternalProbe };

export const createChildManager = (options: ChildManagerOptions): ChildManager => {
  const { role, timers, clock, logger } = options;
  const stopValuesReader =
    options.stopValues ??
    createStopValuesReader({ onNotice: (detail) => writeEvent(logger, settingsWarning({ detail })) });

  let state: ChildState = 'pending';
  let generation = 0;
  let launches = 0;
  let consecutiveFailures = 0;
  let leaked = false;
  let current: Life | undefined;
  let lastExit: LastExit | undefined;
  const capabilityHolders = new Set<Life>();
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
  let heldForVersion = false;
  let freshSpawns = 0;

  const startsNothing = (): boolean => options.isDraining() || options.isRetiring() || heldForVersion;

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
      if (startsNothing() || generation !== armedGeneration) return;
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
      if (startsNothing() || generation !== armedGeneration) return;
      spawnFresh('backoff');
    });
    log(childBackoff({ child: role, delayMs, consecutiveFailures }));
  };

  const enterWaitingLock = (): void => {
    setState('waiting-lock');
    const armedGeneration = generation;
    const isStale = (): boolean => startsNothing() || generation !== armedGeneration;
    lockWatch = watchLock({
      role,
      lockPath: options.endpoint.lockPath,
      socketPath: options.endpoint.socketPath,
      lockWaitMs: options.lockWaitMs,
      lockWatchIntervalMs: options.intervals.lockWatchIntervalMs,
      externalPollMs: options.intervals.externalPollMs,
      timers,
      ...omitUndefined({ mechanism: options.lockMechanism }),
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
      onTransient: options.onTransientError,
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

  const spawnProcess = (
    snapshot: Extract<UserSettingsSnapshot, { settings: unknown }>,
    handoff: LockHandoff | undefined,
  ): { marker: DaemonMarker; handle: ChildHandle; capability: string | undefined } => {
    const skippedNames: string[] = [];
    const resolved = resolveLaunch({
      role,
      launcher: options.launcher,
      home: options.home,
      generation: options.generation,
      ...omitUndefined({ runtime: options.runtime, gateway: options.gateway }),
      baseEnv: definedEnv(options.env),
      separateEnv: (merged) =>
        role === 'gateway'
          ? gatewayEnv(merged, snapshot.settings, options.home, (name) => skippedNames.push(name))
          : runtimeEnv(merged, snapshot.settings).env,
    });
    if (role === 'gateway') reportSkippedNames(skippedNames);
    const spawnCapability = role === 'gateway' ? randomBytes(CAPABILITY_BYTES).toString('hex') : undefined;
    const marker = openDaemonMarker(options.paths.markers.daemons, role, options.markerPorts?.files);
    try {
      const handle = options.spawn(resolved.command, resolved.args, {
        cwd: options.home,
        env: { ...resolved.env, [SETTINGS_APPLIED_ENV]: generationLayout(options.home, options.generation).settingsApplied, ...(handoff === undefined ? {} : handoff.env), ...(spawnCapability === undefined ? {} : { [CREDENTIAL_CAPABILITY_ENV]: spawnCapability }) },
        detached: true,
        markerFile: marker.path,
        stdio: childStdio(marker.fd, handoff?.descriptor),
      });
      return { marker, handle, capability: spawnCapability };
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
    options.onReady();
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
      if (fields.version !== options.version) {
        log(childVersionMismatch({ child: role, childPid: life.pid ?? null, childVersion: fields.version, supervisorVersion: options.version }));
        heldForVersion = true;
        void stop('ready-mismatch', 'term');
        options.onVersionMismatch({ role, childVersion: fields.version });
        return true;
      }
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

  const endCapability = (life: Life): void => {
    life.capability = undefined;
    capabilityHolders.delete(life);
  };

  const failLifeWithoutProcess = (life: Life, error: NodeJS.ErrnoException): void => {
    life.failed = true;
    endCapability(life);
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

  const reapManagedServers = async (life: Life): Promise<void> => {
    if (!runsManagedServers(role)) return;
    const values = life.stopValues ?? stopValuesReader.read();
    const reapStop = new AbortController();
    const bound = options.timers.setTimeout(() => reapStop.abort(), managedServerReapBoundMs(values));
    try {
      await (options.markerPorts?.reapMarkerDirectory ?? reapMarkerDirectory)({
        dir: options.paths.markers.targets,
        killGraceMs: values.managedServerStopGraceMs,
        label: 'managed server',
        occasion: 'shutdown',
        onWarning: (detail) => log(settingsWarning({ detail })),
        signal: reapStop.signal,
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      log(orphansWarning({ detail: `the managed servers of the child that ended were not reaped: ${failure.message}` }, failure));
    } finally {
      options.timers.clearTimeout(bound);
    }
  };

  const handleExit = async (life: Life, exit: ChildExit): Promise<void> => {
    life.exited = true;
    endCapability(life);
    life.killStop.abort();
    clearLifeTimers(life);
    if (life.abandoned) {
      await flushStdio(life);
      if (liveLife() === undefined) await reapManagedServers(life);
      return;
    }
    const arrivalGeneration = generation;
    await flushStdio(life);
    await reapManagedServers(life);
    if (options.isDraining()) unreaped.add(life.marker.path);
    else await reapMarker(life.marker.path);
    const draining = options.isDraining();
    if (!draining && generation !== arrivalGeneration) {
      settleStop(life, { killed: life.groupKilled, leaked: false });
      if (current === life) current = undefined;
      return;
    }
    const exitClass = classifyExit({ code: exit.code, signal: exit.signal, stop: life.stopReason });
    const classification: ExitClassification = heldForVersion && life.stopReason === 'ready-mismatch' ? { class: exitClass.class, reason: 'version-mismatch' } : exitClass;
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
    if (heldForVersion) {
      setState('held-version');
      return;
    }
    if (classification.class === 'retired') options.onRetiredExit();
    if (options.isRetiring()) {
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
    if (startsNothing()) return;
    beginAttempt();
    if ('error' in snapshot) {
      hold(snapshot.error.message, 'settings');
      return;
    }
    let claim: LockHandoffClaim;
    try {
      claim = claimLockForChild(options.endpoint.lockPath, omitUndefined({ mechanism: options.lockMechanism }));
    } catch (error) {
      launches += 1;
      failWithoutProcess('spawn-failed', error);
      return;
    }
    if (claim.kind === 'held') {
      enterWaitingLock();
      return;
    }
    const handoff = claim.kind === 'claimed' ? claim.handoff : undefined;
    launches += 1;
    heldReason = undefined;
    readyAt = undefined;
    let started: { marker: DaemonMarker; handle: ChildHandle; capability: string | undefined };
    try {
      started = spawnProcess(snapshot, handoff);
    } catch (error) {
      handoff?.closeParentCopy();
      failWithoutProcess('spawn-failed', error);
      return;
    }
    handoff?.closeParentCopy();
    const { marker, handle, capability } = started;
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
      stopValues: undefined,
      signalled: false,
      budgetEndsAt: undefined,
      stopPromise: undefined,
      resolveStop: undefined,
      groupKilled: false,
      killStop: new AbortController(),
      exited: false,
      abandoned: false,
      failed: false,
      capability,
      timers: {},
    };
    if (capability !== undefined) capabilityHolders.add(life);
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
    if (startsNothing()) return;
    freshSpawns += 1;
    const asked = freshSpawns;
    const askedGeneration = generation;
    const overtaken = (): boolean => startsNothing() || asked !== freshSpawns || generation !== askedGeneration;
    options.settings
      .load(options.signal)
      .then(
        (snapshot) => {
          if (!overtaken()) launch(snapshot, reason);
        },
        (error: unknown) => {
          if (overtaken()) return;
          beginAttempt();
          failWithoutProcess('settings-read-failed', error);
        },
      )
      .catch((error: unknown) => options.onBackgroundError(error, 'spawn-fresh'));
  }

  const declareUnkillable = (life: Life): void => {
    if (life.exited || life.abandoned) return;
    life.killStop.abort();
    life.abandoned = true;
    generation += 1;
    leaked = true;
    setState('stopped');
    unreaped.add(life.marker.path);
    log(childUnkillable({ child: role, childPid: life.pid ?? null }));
    settleStop(life, { killed: true, leaked: true });
  };

  const forceKill = (life: Life): void => {
    if (life.exited || life.groupKilled) return;
    clearLifeTimer(life, 'budget');
    life.groupKilled = true;
    life.timers.confirm = schedule('kill-confirm-timer', options.intervals.killConfirmMs, () => {
      life.timers.confirm = undefined;
      declareUnkillable(life);
    });
    life.handle.killGroup(life.killStop.signal).catch(() => declareUnkillable(life));
  };

  const armBudget = (life: Life, ms: number): void => {
    clearLifeTimer(life, 'budget');
    life.budgetEndsAt = clock.now() + ms;
    life.timers.budget = schedule('stop-budget-timer', ms, () => {
      life.timers.budget = undefined;
      forceKill(life);
    });
  };

  const budgetFor = (reason: StopReason, mode: StopMode, values: StopValues): number =>
    stopsAStart(reason) && mode === 'term' ? options.restart.startupKillGraceMs : stopBudgetMs(role, mode, values);

  const signalOf = (mode: StopMode): NodeJS.Signals => (mode === 'int' ? 'SIGINT' : 'SIGTERM');

  const signalStop = (life: Life): void => {
    if (life.exited || life.groupKilled || life.stopMode === undefined) return;
    life.signalled = true;
    life.handle.kill(signalOf(life.stopMode));
  };

  const sendStop = (life: Life, values: StopValues): void => {
    const lifeline = life.handle.lifeline;
    if (lifeline === null) {
      forceKill(life);
      return;
    }
    lifeline.write(formatStopMessage(values), (error) => {
      if (error === null || error === undefined) signalStop(life);
      else forceKill(life);
    });
  };

  const stopWithoutProcess = (reason: StopReason): ChildStopResult => {
    clearScheduled();
    if (state !== 'stopped') {
      generation += 1;
      setState('stopped');
    }
    return { killed: false, leaked };
  };

  function stop(reason: StopReason, mode: StopMode, values?: StopValues): Promise<ChildStopResult> {
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
        if (life.signalled) life.handle.kill('SIGINT');
        if (!life.groupKilled && life.budgetEndsAt !== undefined && life.stopValues !== undefined) {
          armBudget(life, Math.min(budgetFor(life.stopReason, 'int', life.stopValues), Math.max(0, life.budgetEndsAt - clock.now())));
        }
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
      const stopValues = values ?? stopValuesReader.read();
      life.stopValues = stopValues;
      armBudget(life, budgetFor(reason, mode, stopValues));
      sendStop(life, stopValues);
    }
    return life.stopPromise;
  }

  const enterDraining = (): void => {
    clearScheduled();
    generation += 1;
    if (liveLife() === undefined) setState('stopped');
  };

  const enterRetiring = (): void => {
    clearScheduled();
    if (liveLife() === undefined && state !== 'held-version') setState('stopped');
  };

  const ENDED_STATES: ReadonlySet<ChildState> = new Set<ChildState>(['pending', 'stopped', 'held-version']);

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
    spawnWith: launch,
    spawnFresh,
    failWithoutProcess: (reason) => {
      beginAttempt();
      recordFailureWithoutProcess(reason);
    },
    holdsCapability: (given) => {
      const offered = Buffer.from(given);
      return [...capabilityHolders].some((life) => {
        if (life.capability === undefined) return false;
        const expected = Buffer.from(life.capability);
        return offered.length === expected.length && timingSafeEqual(offered, expected);
      });
    },
    retryHeld: () => {
      if (startsNothing() || state !== 'held-config') return;
      consecutiveFailures = 0;
      spawnFresh('settings-change');
    },
    stop,
    enterDraining,
    enterRetiring,
    hasEnded: () => ENDED_STATES.has(state) && liveLife() === undefined,
    unreapedMarkers: () => [...unreaped],
    inFlightReaps: () => inFlightReaps,
    awaitLeave,
  };
};
