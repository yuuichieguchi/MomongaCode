import path from 'node:path';
import type fs from 'node:fs';
import { createStopValuesReader, createUserSettingsCache, noKeptRecords, userSettingsChangeKey } from '@momonga/config';
import type { StopValuesReader } from '@momonga/config';
import {
  EXIT_VERSION_MISMATCH,
  RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS,
  acquireProcessLock,
  announceReady,
  canonicalPath,
  createJsonLogger,
  daemonStopBoundMs,
  ensureGenerationDirs,
  generationLayout,
  momongaPaths,
  publishCurrentGeneration,
  roleEndpoint,
  runtimeMaxCloseMs,
  systemClock,
} from '@momonga/foundation';
import type { AtomicWriteFileSystem, Clock, JsonLogger, KernelLockMechanism, ProcessLock, ReadyFields, ReapTiming, StopValues, TextStream } from '@momonga/foundation';
import type { SupervisorHealth, SupervisorPhase } from '@momonga/protocol';
import { SUPERVISOR_API_VERSION } from '@momonga/protocol';
import { createChildManager } from './child-manager.ts';
import type { ChildManager, SpawnPort } from './child-manager.ts';
import { HELD_RETRY_MS, LOCK_WAIT_DEADLINE_MS, ORPHAN_REAP_GRACE_MS, STARTUP_TIMEOUT_MS, SUPERVISOR_GENERATION, SUPERVISOR_SERVICE, resolveIntervals } from './constants.ts';
import type { SupervisorIntervals, SupervisorTimers } from './constants.ts';
import { startControlServer } from './control-server.ts';
import { handedCredentialNames } from './child-env.ts';
import type { ControlServer } from './control-server.ts';
import { runLaunchTask } from './launch.ts';
import type { ChildRole, GatewayTuning, Launcher, RuntimeTuning } from './launcher.ts';
import { phaseChange, settingsChanged, settingsInvalid, settingsReadFailed, settingsWarning, supervisorBackgroundFailed, supervisorBackgroundTransient, writeEvent } from './log-events.ts';
import { omitUndefined } from './omit-undefined.ts';
import { orphanReapBoundMs } from './orphans.ts';
import type { MarkerPorts } from './orphans.ts';
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
  currentFileSystem?: AtomicWriteFileSystem;
  stdout?: TextStream;
  spawn: SpawnPort;
  signal?: AbortSignal;
  stopValues?: StopValuesReader;
  onShutdownRequested?: (values?: StopValues) => void;
};

export type SupervisorStartTiming = { drainTimeoutMs: number; startupTimeoutMs: number; orphanGraceMs: number; orphanReapGraceMs: number; orphanPollMs: number };

export const resolveStartTiming = (options: Pick<SupervisorOptions, 'runtime' | 'startupTimeoutMs' | 'orphanGraceMs' | 'orphanReapGraceMs' | 'intervals'>): SupervisorStartTiming => {
  const drainTimeoutMs = options.runtime?.drainTimeoutMs ?? RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS;
  return {
    drainTimeoutMs,
    startupTimeoutMs: options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
    orphanGraceMs: options.orphanGraceMs ?? runtimeMaxCloseMs(drainTimeoutMs),
    orphanReapGraceMs: options.orphanReapGraceMs ?? ORPHAN_REAP_GRACE_MS,
    orphanPollMs: resolveIntervals(options.intervals).orphanPollMs,
  };
};

export const supervisorStartBoundMs = (timing: SupervisorStartTiming): number => orphanReapBoundMs(timing) + timing.startupTimeoutMs;

export type SupervisorCloseResult = { clean: boolean; killed: ChildRole[]; leaked: ChildRole[]; fatal?: Error; exitCode?: number };

export type SupervisorProcess = {
  ready: ReadyFields;
  health(): SupervisorHealth;
  close(values?: StopValues): Promise<SupervisorCloseResult>;
  abort(values?: StopValues): Promise<SupervisorCloseResult>;
  closed: Promise<SupervisorCloseResult>;
  fatal: Promise<Error>;
};

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
  const startTiming = resolveStartTiming(options);
  const { drainTimeoutMs, startupTimeoutMs } = startTiming;
  const canonicalHome = canonicalPath(options.home);
  const paths = momongaPaths(canonicalHome, process.platform, {});
  const env = { ...(options.env ?? process.env) };
  const lockOptions = omitUndefined({ mechanism: options.lockMechanism });

  const own = generationLayout(canonicalHome, SUPERVISOR_GENERATION);

  await ensureGenerationDirs(paths, own.generation);
  const lock = await (options.acquireLock ?? ((lockPath) => acquireProcessLock(lockPath, undefined, lockOptions)))(own.locks.supervisor);

  let server: ControlServer | undefined;
  try {
    const startedAt = new Date(clock.now()).toISOString();
    let phase: SupervisorPhase = 'reaping-orphans';
    let draining = false;
    let lastEvaluatedKey: string | undefined;
    let lastReadFailure: string | undefined;
    let launchPromise: Promise<void> = Promise.resolve();
    let settingsWatcher: SettingsWatch | undefined;
    let versionMismatch = false;
    let requestShutdown: (values?: StopValues) => void = () => undefined;
    let stopBoundMs: number | undefined;
    let published = false;
    let publishPromise: Promise<void> = Promise.resolve();
    let publishOnceAllReady: () => void = () => undefined;
    const launchController = new AbortController();
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

    const settings = createUserSettingsCache({ home: canonicalHome, onWarning: (detail) => log(settingsWarning({ detail })), keptRecords: noKeptRecords });
    const stopValues =
      options.stopValues ??
      createStopValuesReader({
        load: () => {
          const snapshot = settings.snapshot();
          if ('error' in snapshot) throw snapshot.error;
          return snapshot.settings.gateway;
        },
        onNotice: (detail) => log(settingsWarning({ detail })),
      });

    const createManager = (role: ChildRole): ChildManager =>
      createChildManager({
        role,
        home: canonicalHome,
        paths,
        generation: own.generation,
        endpoint: roleEndpoint(own, role),
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
        version: options.version,
        isDraining: () => draining,
        onVersionMismatch: () => {
          versionMismatch = true;
          requestShutdown();
        },
        stopValues,
        onReady: () => publishOnceAllReady(),
        onBackgroundError: reportBackground,
        onTransientError: reportTransient,
        ...omitUndefined({ runtime: options.runtime, gateway: options.gateway, lockMechanism: options.lockMechanism, markerPorts: options.markerPorts }),
      });

    const gateway = createManager('gateway');
    const runtime = createManager('runtime');
    const managers = [gateway, runtime] as const;

    publishOnceAllReady = (): void => {
      if (published || draining || !managers.every((manager) => manager.state() === 'ready')) return;
      published = true;
      publishPromise = publishCurrentGeneration(paths, { generation: own.generation, version: options.version, sockets: own.sockets }, options.currentFileSystem).catch((error: unknown) =>
        reportBackground(error, 'publish-current'),
      );
    };
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
      ...(stopBoundMs === undefined ? {} : { stopBoundMs }),
    });

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
      log(settingsChanged({}));
    };

    const evaluate = (): void => {
      if (draining) return;
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
        settingsWatcher?.stop();
      },
      awaitBackground: async () => {
        await Promise.all([launchPromise, publishPromise]);
      },
      closeControl: async () => {
        await server?.close();
      },
      releaseLock: () => lock.release(),
      onFatal: (error) => reportBackground(error, 'shutdown'),
    });

    const withExitCode = async (closing: Promise<SupervisorCloseResult>): Promise<SupervisorCloseResult> => {
      const result = await closing;
      return versionMismatch ? { ...result, exitCode: EXIT_VERSION_MISMATCH } : result;
    };
    const closedWithExitCode = withExitCode(shutdown.closed);
    const valuesOfStop = (given: StopValues | undefined): StopValues | undefined => {
      if (shutdown.mode() !== 'idle') return given;
      const values = given ?? stopValues.read();
      stopBoundMs = daemonStopBoundMs(values);
      return values;
    };
    const closeWithExitCode = (values?: StopValues): Promise<SupervisorCloseResult> => {
      void shutdown.close(valuesOfStop(values));
      return closedWithExitCode;
    };
    const abortWithExitCode = (values?: StopValues): Promise<SupervisorCloseResult> => {
      void shutdown.abort(valuesOfStop(values));
      return closedWithExitCode;
    };

    requestShutdown = (values?: StopValues): void => {
      if (options.onShutdownRequested === undefined) void closeWithExitCode(values);
      else options.onShutdownRequested(values);
    };

    options.signal?.throwIfAborted();
    server = await startControlServer({
      ...omitUndefined({ startSignal: options.signal }),
      socketPath: own.sockets.supervisor,
      timers,
      health,
      credential: (name) => {
        if (!handedCredentialNames(settings.read().settings).includes(name)) return { kind: 'undeclared' };
        const value = env[name];
        return value === undefined || value === '' ? { kind: 'unset' } : { kind: 'value', value };
      },
      onShutdownRequested: (values) => requestShutdown(values),
      onIgnoredStopValues: (reason) => log(settingsWarning({ detail: `the stop values of the shutdown request were malformed and were ignored: ${reason}` })),
      onError: (error) => reportBackground(error, 'control-server'),
      ...lockOptions,
    });

    const ready: ReadyFields = { service: SUPERVISOR_SERVICE, pid: process.pid, version: options.version, socketPath: own.sockets.supervisor, startedAt };
    announceReady(ready, options.stdout);

    launchPromise = runLaunchTask({
      signal: launchController.signal,
      logger,
      reap: {
        markersDir: paths.markers.daemons,
        orphanGraceMs: startTiming.orphanGraceMs,
        orphanReapGraceMs: startTiming.orphanReapGraceMs,
        orphanPollMs: startTiming.orphanPollMs,
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

    return { ready, health, close: closeWithExitCode, abort: abortWithExitCode, closed: closedWithExitCode, fatal };
  } catch (error) {
    try {
      await server?.close();
    } finally {
      lock.release();
    }
    throw error;
  }
};
