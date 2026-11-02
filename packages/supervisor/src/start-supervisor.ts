import path from 'node:path';
import type fs from 'node:fs';
import { createUserSettingsCache, userSettingsChangeKey } from '@momonga/config';
import {
  RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS,
  acquireProcessLock,
  announceReady,
  canonicalPath,
  createJsonLogger,
  ensureMomongaDirs,
  momongaPaths,
  runtimeMaxCloseMs,
  systemClock,
} from '@momonga/foundation';
import type { Clock, JsonLogger, KernelLockMechanism, ProcessLock, ReadyFields, ReapTiming, TextStream } from '@momonga/foundation';
import type { SupervisorHealth, SupervisorPhase } from '@momonga/protocol';
import { SUPERVISOR_API_VERSION } from '@momonga/protocol';
import { createChildManager } from './child-manager.ts';
import type { ChildManager, SpawnPort } from './child-manager.ts';
import { HELD_RETRY_MS, LOCK_WAIT_DEADLINE_MS, ORPHAN_REAP_GRACE_MS, STARTUP_TIMEOUT_MS, SUPERVISOR_SERVICE, resolveIntervals } from './constants.ts';
import type { SupervisorIntervals, SupervisorTimers } from './constants.ts';
import { startControlServer } from './control-server.ts';
import type { ControlServer } from './control-server.ts';
import { shutdownIfIdle } from './idle-shutdown.ts';
import { runLaunchTask } from './launch.ts';
import type { ChildRole, GatewayTuning, Launcher, RuntimeTuning } from './launcher.ts';
import { phaseChange, planBegin, planEnd, settingsChanged, settingsEvaluated, settingsInvalid, settingsReadFailed, settingsWarning, supervisorBackgroundFailed, supervisorBackgroundTransient, writeEvent } from './log-events.ts';
import { omitUndefined } from './omit-undefined.ts';
import type { MarkerPorts } from './orphans.ts';
import { digestsOf, planRoles, runRestartPlan } from './plan.ts';
import type { RestartPlanPort } from './plan.ts';
import { resolveRestartPolicy } from './restart-policy.ts';
import type { RestartPolicy } from './restart-policy.ts';
import { safeChangeKey, watchSettings } from './settings-watch.ts';
import type { SettingsWatch } from './settings-watch.ts';
import { createShutdownController } from './shutdown.ts';

export type SupervisorOptions = {
  home: string;
  version: string;
  launcher: Launcher;
  env?: Readonly<Record<string, string | undefined>>;
  runtime?: RuntimeTuning;
  gateway?: GatewayTuning;
  startupTimeoutMs?: number;
  lockWaitMs?: number;
  orphanGraceMs?: number;
  orphanReapGraceMs?: number;
  heldRetryMs?: number;
  restart?: Partial<RestartPolicy>;
  intervals?: Partial<SupervisorIntervals>;
  watchSettings?: boolean;
  settingsWatch?: typeof fs.watch;
  clock?: Clock;
  timers?: SupervisorTimers;
  random?: () => number;
  logger?: JsonLogger;
  droppedLogLines?: () => number;
  reapTiming?: ReapTiming;
  lockMechanism?: KernelLockMechanism;
  acquireLock?: (lockPath: string) => Promise<ProcessLock>;
  markerPorts?: MarkerPorts;
  stdout?: TextStream;
  spawn: SpawnPort;
  signal?: AbortSignal;
  onShutdownRequested?: () => void;
};

export type SupervisorCloseResult = { clean: boolean; killed: ChildRole[]; leaked: ChildRole[]; fatal?: Error };

export type SupervisorProcess = {
  ready: ReadyFields;
  health(): SupervisorHealth;
  close(): Promise<SupervisorCloseResult>;
  abort(): Promise<SupervisorCloseResult>;
  closed: Promise<SupervisorCloseResult>;
  fatal: Promise<Error>;
};

const PLANNABLE_STATES: ReadonlySet<string> = new Set(['starting', 'ready', 'stopping', 'backoff']);

const realTimers: SupervisorTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const failureOf = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

export const startSupervisor = async (options: SupervisorOptions): Promise<SupervisorProcess> => {
  const clock = options.clock ?? systemClock;
  const timers = options.timers ?? realTimers;
  const logger = options.logger ?? createJsonLogger({ service: SUPERVISOR_SERVICE, clock });
  const intervals = resolveIntervals(options.intervals);
  const restart = resolveRestartPolicy(options.restart);
  const drainTimeoutMs = options.runtime?.drainTimeoutMs ?? RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS;
  const startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  const canonicalHome = canonicalPath(options.home);
  const paths = momongaPaths(canonicalHome, process.platform, {});
  const env = { ...(options.env ?? process.env) };
  const lockOptions = omitUndefined({ mechanism: options.lockMechanism });

  await ensureMomongaDirs(paths);
  const lock = await (options.acquireLock ?? ((lockPath) => acquireProcessLock(lockPath, undefined, lockOptions)))(paths.locks.supervisor);

  let server: ControlServer | undefined;
  try {
    const startedAt = new Date(clock.now()).toISOString();
    let phase: SupervisorPhase = 'reaping-orphans';
    let draining = false;
    let planRunning = false;
    let evaluationPending = false;
    let lastEvaluatedKey: string | undefined;
    let lastReadFailure: string | undefined;
    let launchPromise: Promise<void> = Promise.resolve();
    let planPromise: Promise<void> = Promise.resolve();
    let settingsWatcher: SettingsWatch | undefined;
    const launchController = new AbortController();
    const planController = new AbortController();
    const reportedSources = new Set<string>();
    let resolveFatal: (error: Error) => void = () => undefined;
    const fatal = new Promise<Error>((resolve) => {
      resolveFatal = resolve;
    });

    const log = writeEvent.bind(undefined, logger);

    const reportedTransient = new Map<string, string>();

    const reportTransient = (error: unknown, source: string): void => {
      const failure = failureOf(error);
      if (reportedTransient.get(source) === failure.message) return;
      reportedTransient.set(source, failure.message);
      log(supervisorBackgroundTransient({ source }, failure));
    };

    const reportBackground = (error: unknown, source: string): void => {
      const failure = failureOf(error);
      if (!reportedSources.has(source)) {
        reportedSources.add(source);
        log(supervisorBackgroundFailed({ source }, failure));
      }
      resolveFatal(failure);
    };

    const setPhase = (next: SupervisorPhase): void => {
      if (phase === next) return;
      const from = phase;
      phase = next;
      log(phaseChange({ from, to: next }));
    };

    const reapTiming: ReapTiming = options.reapTiming ?? {
      now: () => clock.now(),
      sleep: (ms) => new Promise<void>((resolve) => timers.setTimeout(resolve, ms)),
    };

    const settings = createUserSettingsCache({ home: canonicalHome, onWarning: (detail) => log(settingsWarning({ detail })) });

    const createManager = (role: ChildRole): ChildManager =>
      createChildManager({
        role,
        home: canonicalHome,
        paths,
        launcher: options.launcher,
        env,
        spawn: options.spawn,
        settings,
        logger,
        clock,
        timers,
        random: options.random ?? Math.random,
        restart,
        intervals,
        startupTimeoutMs,
        heldRetryMs: options.heldRetryMs ?? HELD_RETRY_MS,
        lockWaitMs: options.lockWaitMs ?? LOCK_WAIT_DEADLINE_MS,
        isDraining: () => draining,
        onBackgroundError: reportBackground,
        onTransientError: reportTransient,
        ...omitUndefined({ runtime: options.runtime, gateway: options.gateway, lockMechanism: options.lockMechanism, markerPorts: options.markerPorts }),
      });

    const gateway = createManager('gateway');
    const runtime = createManager('runtime');
    const managers = [gateway, runtime] as const;
    const managerOf = (role: ChildRole): ChildManager => (role === 'gateway' ? gateway : runtime);

    const health = (): SupervisorHealth => ({
      status: 'ok',
      version: options.version,
      apiVersion: SUPERVISOR_API_VERSION,
      pid: process.pid,
      startedAt,
      phase,
      env: 'frozen at supervisor start',
      children: [gateway.health(), runtime.health()],
      logs: { droppedLines: options.droppedLogLines?.() ?? 0 },
    });

    const planPort: RestartPlanPort = {
      isDraining: () => draining,
      stop: async (role) => {
        await managerOf(role).stop('plan-restart', 'term');
      },
      start: (role) => managerOf(role).planStart(),
      awaitSettled: async (role, timeoutMs) => {
        await managerOf(role).awaitLeave('starting', { timeoutMs, signal: planController.signal });
      },
      isPlanStopped: (role) => managerOf(role).isPlanStopped(),
    };

    let evaluate: () => void = () => undefined;

    const startPlan = (roles: readonly ChildRole[]): void => {
      planRunning = true;
      log(planBegin({ roles: roles.join(','), planned: roles.length }));
      planPromise = runRestartPlan({ roles, port: planPort, signal: planController.signal, startupTimeoutMs })
        .catch((error: unknown) => reportBackground(error, 'restart-plan'))
        .then(() => {
          planRunning = false;
          log(planEnd({ roles: roles.join(','), planned: roles.length }));
          if (evaluationPending && !draining) {
            evaluationPending = false;
            evaluate();
          }
        })
        .catch((error: unknown) => reportBackground(error, 'restart-plan'));
    };

    const reportReadFailure = (error: unknown): void => {
      const failure = failureOf(error);
      if (failure.message === lastReadFailure) return;
      lastReadFailure = failure.message;
      log(settingsReadFailed({ detail: failure.message }, failure));
    };

    const evaluateOnce = (): void => {
      const key = safeChangeKey(() => userSettingsChangeKey(canonicalHome));
      if (key === lastEvaluatedKey) return;
      for (const manager of managers) manager.retryHeld();
      let snapshot: ReturnType<typeof settings.snapshot>;
      try {
        snapshot = settings.snapshot();
      } catch (error) {
        reportReadFailure(error);
        return;
      }
      lastEvaluatedKey = key;
      lastReadFailure = undefined;
      if ('error' in snapshot) {
        log(settingsInvalid({ detail: snapshot.error.message, action: 'keep-running-children-hold-spawns' }));
        return;
      }
      const current = digestsOf(snapshot.settings);
      const runtimeApplied = runtime.appliedDigests();
      const gatewayApplied = gateway.appliedDigests();
      const modelsChanged = (runtimeApplied !== undefined && runtimeApplied.models !== current.models) || (gatewayApplied !== undefined && gatewayApplied.models !== current.models);
      const sandboxChanged = runtimeApplied !== undefined && runtimeApplied.sandbox !== current.sandbox;
      if (modelsChanged || sandboxChanged) log(settingsChanged({ models: modelsChanged, sandbox: sandboxChanged }));
      const roles = planRoles(current, {
        ...(runtimeApplied !== undefined && PLANNABLE_STATES.has(runtime.state()) ? { runtime: runtimeApplied } : {}),
        ...(gatewayApplied !== undefined && PLANNABLE_STATES.has(gateway.state()) ? { gateway: gatewayApplied } : {}),
      });
      log(settingsEvaluated({ modelsChanged, sandboxChanged, roles: roles.join(',') }));
      if (roles.length > 0) startPlan(roles);
    };

    evaluate = (): void => {
      if (draining) return;
      if (planRunning) {
        evaluationPending = true;
        return;
      }
      try {
        evaluateOnce();
      } catch (error) {
        reportReadFailure(error);
      }
    };

    const startWatch = (initialKey: string): SettingsWatch | undefined => {
      if (options.watchSettings === false) return undefined;
      lastEvaluatedKey = initialKey;
      settingsWatcher = watchSettings({
        directory: path.dirname(paths.settingsFile),
        file: path.basename(paths.settingsFile),
        debounceMs: intervals.settingsDebounceMs,
        pollMs: intervals.settingsPollMs,
        changeKey: () => userSettingsChangeKey(canonicalHome),
        initialKey,
        onChange: evaluate,
        onWarning: (error) => log(settingsWarning({ detail: error.message })),
        onError: (error) => reportBackground(error, 'settings-watch'),
        timers,
        ...omitUndefined({ watch: options.settingsWatch }),
      });
      return settingsWatcher;
    };

    const shutdown = createShutdownController({
      runtime,
      gateway,
      drainTimeoutMs,
      timers,
      logger,
      ...omitUndefined({ markerPorts: options.markerPorts }),
      beginDraining: () => {
        draining = true;
        setPhase('draining');
        launchController.abort();
        planController.abort();
        settingsWatcher?.stop();
      },
      awaitBackground: async () => {
        await Promise.all([launchPromise, planPromise]);
      },
      closeControl: async () => {
        await server?.close();
      },
      releaseLock: () => lock.release(),
      onFatal: (error) => reportBackground(error, 'shutdown'),
    });

    options.signal?.throwIfAborted();
    server = await startControlServer({
      socketPath: paths.sockets.supervisor,
      timers,
      health,
      shutdownIfIdle: () =>
        phase === 'draining' ? Promise.resolve({ kind: 'accepted' }) : shutdownIfIdle({ runtime: runtime.health(), runtimeSocketPath: paths.sockets.runtime }),
      onShutdownRequested: () => {
        if (options.onShutdownRequested === undefined) void shutdown.close();
        else options.onShutdownRequested();
      },
      onError: (error) => reportBackground(error, 'control-server'),
      ...lockOptions,
    });

    const ready: ReadyFields = { service: SUPERVISOR_SERVICE, pid: process.pid, version: options.version, socketPath: paths.sockets.supervisor, startedAt };
    announceReady(ready, options.stdout);

    launchPromise = runLaunchTask({
      signal: launchController.signal,
      logger,
      reap: {
        markersDir: paths.markers.daemons,
        orphanGraceMs: options.orphanGraceMs ?? runtimeMaxCloseMs(drainTimeoutMs) + 2000,
        orphanReapGraceMs: options.orphanReapGraceMs ?? ORPHAN_REAP_GRACE_MS,
        orphanPollMs: intervals.orphanPollMs,
        drainTimeoutMs,
        timers,
        signal: launchController.signal,
        logger,
        reapTiming,
        ...omitUndefined({ markerPorts: options.markerPorts }),
      },
      settings,
      changeKey: () => userSettingsChangeKey(canonicalHome),
      gateway,
      runtime,
      enterRunning: () => setPhase('running'),
      startWatch,
      evaluate,
    }).catch((error: unknown) => reportBackground(error, 'launch-task'));

    return { ready, health, close: shutdown.close, abort: shutdown.abort, closed: shutdown.closed, fatal };
  } catch (error) {
    try {
      await server?.close();
    } finally {
      lock.release();
    }
    throw error;
  }
};
