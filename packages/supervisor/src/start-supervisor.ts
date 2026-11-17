import { syncPaths } from '@momonga/foundation';
import path from 'node:path';
import type fs from 'node:fs';
import { createStopValuesReader, createUserSettingsCache, noKeptRecords, stopValuesOfSettings, userSettingsChangeKey, writeAppliedRecord } from '@momonga/config';
import type { StopValuesReader } from '@momonga/config';
import {
  GenerationDirectoryMissingError,
  acquireProcessLock,
  announceReady,
  claimGeneration,
  createJsonLogger,
  daemonStopBoundMs,
  generationLayout,
  endpointScopeOf,
  nodeFileSystem,
  hostPaths,
  listGenerations,
  momongaPaths,
  publishCurrentGeneration,
  readCurrentGeneration,
  reapMarkerDirectory,
  requireGenerationDirs,
  roleEndpoint,
  scopeToGeneration,
  startDeadlineSignal,
  systemClock,
  systemRandom,
  writeStopRecord,
  SECRET_BACKEND_ENV,
  SECRET_PROGRAM_ENV,
  SECRET_REFUSAL_ENV,
  secretStoreEnvFor,
} from '@momonga/foundation';
import type { AbandonReason, AtomicWriteFileSystem, Clock, GenerationRole, JsonLogger, KernelLockMechanism, ProcessLock, ReadyFields, StopValues, Timing, TextStream, ProcessInspector } from '@momonga/foundation';
import type { SupervisorHealth, SupervisorPhase } from '@momonga/protocol';
import { FIDELITY_FOLD_VERSION } from '@momonga/protocol';
import { readChildCounts } from './child-counts.ts';
import type { ChildCountsReader, GenerationCounts } from './child-counts.ts';
import { createChildManager } from './child-manager.ts';
import type { ChildManager, SpawnPort } from './child-manager.ts';
import { DAEMON_MARKER_KILL_GRACE_MS, HELD_RETRY_MS, MANY_GENERATIONS_THRESHOLD, STARTUP_TIMEOUT_MS, SUPERVISOR_SERVICE, resolveIntervals } from './constants.ts';
import type { SupervisorIntervals, SupervisorTimers } from './constants.ts';
import { startControlServer } from './control-server.ts';
import { handedCredentialNames } from './child-env.ts';
import type { ControlServer } from './control-server.ts';
import { runLaunchTask } from './launch.ts';
import type { ChildRole, GatewayTuning, Launcher, RuntimeTuning } from './launcher.ts';
import {
  generationEnded,
  generationMany,
  generationPromoted,
  generationRetiring,
  orphansWarning,
  phaseChange,
  settingsChanged,
  settingsInvalid,
  settingsRecordFailed,
  settingsReadFailed,
  settingsWarning,
  startAbandoned,
  startSuperseded,
  startUnpromoted,
  supervisorBackgroundFailed,
  supervisorBackgroundTransient,
  writeEvent,
  secretStoreChosen,
} from './log-events.ts';
import { omitUndefined } from './omit-undefined.ts';
import type { MarkerPorts } from './orphans.ts';
import { resolveRestartPolicy } from './restart-policy.ts';
import type { RestartPolicy } from './restart-policy.ts';
import { safeChangeKey, watchSettings } from './settings-watch.ts';
import type { SettingsWatch } from './settings-watch.ts';
import { createShutdownController } from './shutdown.ts';
import { createSuccessor } from './successor.ts';
import type { SuccessorLauncher } from './successor.ts';

export type SupervisorOptions = {
  home: string;
  version: string;
  generation: number;
  launcher: Launcher;
  successorLauncher?: SuccessorLauncher;
  reaperPass?: (context: { signal: AbortSignal }) => Promise<void>;
  childCounts?: ChildCountsReader;
  env?: Readonly<Record<string, string | undefined>>;
  runtime?: RuntimeTuning;
  gateway?: GatewayTuning;
  startupTimeoutMs?: number;
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
  reapTiming?: Timing;
  lockMechanism: KernelLockMechanism;
  inspector: ProcessInspector;
  acquireLock?: (lockPath: string) => Promise<ProcessLock>;
  markerPorts?: MarkerPorts;
  currentFileSystem?: AtomicWriteFileSystem;
  stdout?: TextStream;
  spawn: SpawnPort;
  signal?: AbortSignal;
  stopValues?: StopValuesReader;
  onShutdownRequested?: (values?: StopValues) => void;
};

export type SupervisorStartTiming = { startupTimeoutMs: number; generationPollMs: number };

export const resolveStartTiming = (options: Pick<SupervisorOptions, 'startupTimeoutMs' | 'intervals'>): SupervisorStartTiming => ({
  startupTimeoutMs: options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
  generationPollMs: resolveIntervals(options.intervals).generationPollMs,
});

export const generationLockWaitBoundMs = (timing: SupervisorStartTiming): number => timing.startupTimeoutMs + timing.generationPollMs;

export const supervisorStartBoundMs = (timing: SupervisorStartTiming): number => generationLockWaitBoundMs(timing) + timing.startupTimeoutMs;

export type SupervisorCloseResult = { clean: boolean; killed: ChildRole[]; leaked: ChildRole[]; fatal?: Error; exitCode?: number };

export type SupervisorProcess = {
  ready: ReadyFields;
  health(): SupervisorHealth;
  close(values?: StopValues): Promise<SupervisorCloseResult>;
  abort(values?: StopValues): Promise<SupervisorCloseResult>;
  closed: Promise<SupervisorCloseResult>;
  fatal: Promise<Error>;
  role(): GenerationRole;
  abandoned?: AbandonReason;
};

const realTimers: SupervisorTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const failureOf = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

const abandonedStart = (options: SupervisorOptions, own: { sockets: { supervisor: string } }, startedAt: string, reason: AbandonReason): SupervisorProcess => {
  const result: SupervisorCloseResult = { clean: true, killed: [], leaked: [] };
  const closed = Promise.resolve(result);
  options.onShutdownRequested?.();
  return {
    ready: { service: SUPERVISOR_SERVICE, pid: process.pid, version: options.version, socketPath: own.sockets.supervisor, startedAt },
    health: () => ({
      status: 'ok',
      version: options.version,
      pid: process.pid,
      startedAt,
      phase: 'draining',
      env: 'frozen at supervisor start',
      retention: null,
      children: [],
      logs: { droppedLines: options.droppedLogLines?.() ?? 0 },
      generation: options.generation,
      role: 'starting',
    }),
    close: () => closed,
    abort: () => closed,
    closed,
    fatal: new Promise<Error>(() => undefined),
    role: () => 'starting',
    abandoned: reason,
  };
};

type OwnClaim = { kind: 'claimed'; lock: ProcessLock } | { kind: 'abandoned'; reason: AbandonReason };

export const startSupervisor = async (options: SupervisorOptions): Promise<SupervisorProcess> => {
  const clock = options.clock ?? systemClock;
  const timers = options.timers ?? realTimers;
  const logger = options.logger ?? createJsonLogger({ service: SUPERVISOR_SERVICE, clock });
  const intervals = resolveIntervals(options.intervals);
  const restart = resolveRestartPolicy(options.restart);
  const canonicalHome = await hostPaths(startDeadlineSignal(options.signal)).canonicalPath(options.home);
  const { startupTimeoutMs } = resolveStartTiming(options);
  const env = { ...(options.env ?? process.env) };
  const homePaths = momongaPaths(canonicalHome, process.platform, env);
  const secretStoreEnv = await secretStoreEnvFor(env, { platform: process.platform, uid: process.getuid?.(), realPathOf: (file) => syncPaths.canonicalPath(file) });
  const paths = scopeToGeneration(homePaths, options.generation);
  const { lockMechanism, inspector } = options;
  const lockOptions = { mechanism: lockMechanism };
  const processStartedAt = clock.now();
  const startedAt = new Date(processStartedAt).toISOString();
  const log = writeEvent.bind(undefined, logger);
  log(secretStoreChosen({ backend: secretStoreEnv[SECRET_BACKEND_ENV] ?? null, program: secretStoreEnv[SECRET_PROGRAM_ENV] ?? null, refusal: secretStoreEnv[SECRET_REFUSAL_ENV] ?? null }));
  const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => timers.setTimeout(resolve, ms));

  const endpointScope = await endpointScopeOf(homePaths, process.platform, { files: nodeFileSystem, random: systemRandom, lock: lockMechanism });
  const own = generationLayout(canonicalHome, options.generation, process.platform, endpointScope);

  const claimOwn = async (): Promise<OwnClaim> => {
    const acquire = options.acquireLock ?? ((lockPath: string) => acquireProcessLock(lockPath, undefined, lockOptions));
    for (let waited = 0; ; waited += intervals.generationPollMs) {
      options.signal?.throwIfAborted();
      const claim = await claimGeneration(homePaths, own.generation, { version: options.version, lock: lockMechanism, acquire });
      if (claim.kind !== 'busy') return claim;
      if (waited >= startupTimeoutMs) return { kind: 'abandoned', reason: 'lock-held' };
      await sleep(intervals.generationPollMs);
    }
  };

  const abandon = (reason: AbandonReason): SupervisorProcess => {
    log(startAbandoned({ generation: own.generation, reason }));
    return abandonedStart(options, own, startedAt, reason);
  };

  const claimed = await claimOwn();
  if (claimed.kind === 'abandoned') return abandon(claimed.reason);
  const lock = claimed.lock;
  try {
    await requireGenerationDirs(homePaths, own.generation);
  } catch (error) {
    lock.release();
    if (error instanceof GenerationDirectoryMissingError) return abandon('directory-missing');
    throw error;
  }

  let server: ControlServer | undefined;
  try {
    let phase: SupervisorPhase = 'running';
    let role: GenerationRole = 'starting';
    let ended = false;
    let promoting = false;
    let draining = false;
    let superseded = false;
    let lastEvaluatedKey: string | undefined;
    let lastReadFailure: string | undefined;
    let launchPromise: Promise<void> = Promise.resolve();
    let settingsWatcher: SettingsWatch | undefined;
    let requestShutdown: (values?: StopValues) => void = () => undefined;
    let stopBoundMs: number | undefined;
    let publishPromise: Promise<void> = Promise.resolve();
    let pollPromise: Promise<void> = Promise.resolve();
    let reaperPromise: Promise<void> | undefined;
    let pollTimer: unknown;
    let promotionBoundTimer: unknown;
    let counts: GenerationCounts = {};
    let reportedLive: number | undefined;
    const launchController = new AbortController();
    const launchSignal = options.signal === undefined ? launchController.signal : AbortSignal.any([launchController.signal, options.signal]);
    const lifetime = new AbortController();
    const reportedSources = new Set<string>();
    let resolveFatal: (error: Error) => void = () => undefined;
    const fatal = new Promise<Error>((resolve) => {
      resolveFatal = resolve;
    });

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

    const reapTiming: Timing = options.reapTiming ?? {
      now: () => clock.now(),
      monotonicMs: () => clock.now(),
      setTimeout: (callback, ms) => timers.setTimeout(callback, ms),
      clearTimeout: (handle) => timers.clearTimeout(handle),
    };

    const stopValues = options.stopValues ?? createStopValuesReader({ onNotice: (detail) => log(settingsWarning({ detail })) });
    const settings = createUserSettingsCache({ env: process.env,
      home: canonicalHome,
      onWarning: (detail) => log(settingsWarning({ detail })),
      keptRecords: noKeptRecords,
      onLoaded: (loaded) => stopValues.remember(stopValuesOfSettings(loaded.settings)),
    });
    const changeKey = (): Promise<string> => userSettingsChangeKey(canonicalHome, lifetime.signal);

    const endByItself = (): void => {
      if (ended || draining) return;
      ended = true;
      requestShutdown();
    };

    const successor = createSuccessor({
      home: canonicalHome,
      paths: homePaths,
      generation: own.generation,
      version: options.version,
      foldVersion: FIDELITY_FOLD_VERSION,
      lock: lockMechanism,
      scope: endpointScope,
      launcher: options.successorLauncher,
      timers,
      pollMs: intervals.generationPollMs,
      boundMs: startupTimeoutMs,
      logger,
      onError: (error) => reportTransient(error, 'successor'),
    });

    let managers: readonly ChildManager[] = [];

    const becomeRetiring = (current: number | null): void => {
      if (role === 'retiring' || draining) return;
      role = 'retiring';
      log(generationRetiring({ generation: own.generation, current }));
      settingsWatcher?.stop();
      successor.stop();
      for (const manager of managers) manager.enterRetiring();
    };

    const onVersionMismatch = (childVersion: string): void => {
      if (draining || ended) return;
      if (role === 'starting') {
        log(startAbandoned({ generation: own.generation, reason: 'version-differs' }));
        endByItself();
        return;
      }
      if (role === 'serving') void successor.request(childVersion).catch((error: unknown) => reportTransient(error, 'successor'));
    };

    const createManager = (childRole: ChildRole): ChildManager =>
      createChildManager({
        role: childRole,
        home: canonicalHome,
        paths,
        generation: own.generation,
        endpoint: roleEndpoint(own, childRole),
        launcher: options.launcher,
        env,
        secretStoreEnv,
        spawn: options.spawn,
        settings,
        signal: lifetime.signal,
        logger,
        clock,
        timers,
        random: options.random ?? Math.random,
        restart,
        intervals,
        startupTimeoutMs,
        heldRetryMs: options.heldRetryMs ?? HELD_RETRY_MS,
        version: options.version,
        isDraining: () => draining,
        isRetiring: () => role === 'retiring',
        onRetiredExit: () => becomeRetiring(null),
        onVersionMismatch: (mismatch) => onVersionMismatch(mismatch.childVersion),
        stopValues,
        onReady: () => promoteOnceAllReady(),
        onProgress: () => {
          if (promotionBoundTimer !== undefined) armPromotionBound();
        },
        onBackgroundError: reportBackground,
        onTransientError: reportTransient,
        lockMechanism,
        inspector,
        ...omitUndefined({ runtime: options.runtime, gateway: options.gateway, markerPorts: options.markerPorts }),
      });

    const gateway = createManager('gateway');
    const runtime = createManager('runtime');
    managers = [gateway, runtime];

    const runReaperPass = (): void => {
      const pass = options.reaperPass;
      if (pass === undefined || reaperPromise !== undefined || role !== 'serving' || draining) return;
      reaperPromise = pass({ signal: lifetime.signal })
        .catch((error: unknown) => reportTransient(error, 'reaper-pass'))
        .finally(() => {
          reaperPromise = undefined;
        });
    };

    const promote = async (): Promise<void> => {
      const outcome = await publishCurrentGeneration(
        homePaths,
        { generation: own.generation, version: options.version, sockets: own.sockets },
        { lock: lockMechanism, ...omitUndefined({ fs: options.currentFileSystem }) },
      );
      if (outcome === 'busy' || draining || ended) return;
      if (outcome === 'superseded') {
        superseded = true;
        log(startSuperseded({ generation: own.generation, current: (await readCurrentGeneration(homePaths))?.generation ?? own.generation }));
        endByItself();
        return;
      }
      role = 'serving';
      if (promotionBoundTimer !== undefined) timers.clearTimeout(promotionBoundTimer);
      promotionBoundTimer = undefined;
      log(generationPromoted({ generation: own.generation, version: options.version, startToPromotedMs: clock.now() - processStartedAt }));
      runReaperPass();
    };

    function armPromotionBound(): void {
      if (promotionBoundTimer !== undefined) timers.clearTimeout(promotionBoundTimer);
      promotionBoundTimer = timers.setTimeout(() => {
        promotionBoundTimer = undefined;
        if (role !== 'starting' || draining || ended) return;
        log(startUnpromoted({ generation: own.generation, reason: 'startup-bound' }));
        endByItself();
      }, startupTimeoutMs);
    }

    function promoteOnceAllReady(): void {
      if (role !== 'starting' || promoting || draining || ended || !managers.every((manager) => manager.state() === 'ready')) return;
      promoting = true;
      publishPromise = promote()
        .catch((error: unknown) => reportBackground(error, 'publish-current'))
        .finally(() => {
          promoting = false;
        });
    }
    const refreshCounts = async (): Promise<void> => {
      const reader = options.childCounts ?? readChildCounts;
      const read = async (manager: ChildManager): Promise<GenerationCounts> => {
        if (manager.state() !== 'ready') return {};
        try {
          return await reader(manager.role, roleEndpoint(own, manager.role).socketPath);
        } catch (error) {
          reportTransient(error, `child-counts-${manager.role}`);
          return {};
        }
      };
      const [fromGateway, fromRuntime] = await Promise.all([read(gateway), read(runtime)]);
      counts = { ...fromRuntime, ...fromGateway };
    };

    const warnWhenMany = async (): Promise<void> => {
      const live = (await listGenerations(homePaths, { lock: lockMechanism })).filter((listed) => listed.live).length;
      if (live === reportedLive) return;
      reportedLive = live;
      if (live > MANY_GENERATIONS_THRESHOLD) log(generationMany({ live }));
    };

    const pollOnce = async (): Promise<void> => {
      let current: number | undefined;
      try {
        current = (await readCurrentGeneration(homePaths))?.generation;
      } catch (error) {
        reportTransient(error, 'current-generation');
        return;
      }
      if (draining || ended) return;
      if (role === 'starting') {
        if (current !== undefined && current > own.generation) {
          superseded = true;
          log(startSuperseded({ generation: own.generation, current }));
          endByItself();
          return;
        }
        promoteOnceAllReady();
      } else if (role === 'serving' && current !== undefined && current > own.generation) {
        becomeRetiring(current);
      }
      if (role === 'retiring' && managers.every((manager) => manager.hasEnded())) {
        log(generationEnded({ generation: own.generation, liveMs: clock.now() - processStartedAt }));
        endByItself();
        return;
      }
      if (role === 'serving') {
        runReaperPass();
        await warnWhenMany();
      }
      await refreshCounts();
    };

    const armPoll = (): void => {
      if (draining || ended) return;
      pollTimer = timers.setTimeout(() => {
        pollTimer = undefined;
        pollPromise = pollOnce()
          .catch((error: unknown) => reportTransient(error, 'generation-poll'))
          .finally(armPoll);
      }, intervals.generationPollMs);
    };

    const health = (): SupervisorHealth => ({
      status: 'ok',
      version: options.version,
      pid: process.pid,
      startedAt,
      phase,
      env: 'frozen at supervisor start',
      children: [gateway.health(), runtime.health()],
      logs: { droppedLines: options.droppedLogLines?.() ?? 0 },
      ...(stopBoundMs === undefined ? {} : { stopBoundMs }),
      generation: own.generation,
      role,
      ...counts,
      retention: counts.retention ?? null,
    });

    let recordFailedKey: string | undefined;
    let lastWrittenSeq: number | undefined;
    const recordApplied = async (key: string | undefined): Promise<void> => {
      try {
        const written = await writeAppliedRecord(canonicalHome, own.settingsApplied, lastWrittenSeq, { env: process.env, signal: lifetime.signal, random: systemRandom, lock: lockMechanism });
        if (written.kind !== 'invalid') lastWrittenSeq = written.seq;
      } catch (error) {
        if (lifetime.signal.aborted || key === recordFailedKey) return;
        recordFailedKey = key;
        log(settingsRecordFailed({ detail: failureOf(error).message }));
      }
    };

    const reportReadFailure = (error: unknown): void => {
      const failure = failureOf(error);
      if (failure.message === lastReadFailure) return;
      lastReadFailure = failure.message;
      log(settingsReadFailed({ detail: failure.message }, failure));
    };

    const evaluateOnce = async (): Promise<void> => {
      const key = await safeChangeKey(changeKey);
      if (key === lastEvaluatedKey) return;
      let snapshot: ReturnType<typeof settings.snapshot>;
      try {
        snapshot = await settings.load(lifetime.signal);
      } catch (error) {
        if (!lifetime.signal.aborted) reportReadFailure(error);
        return;
      }
      for (const manager of managers) manager.retryHeld();
      lastEvaluatedKey = key;
      lastReadFailure = undefined;
      if ('error' in snapshot) {
        log(settingsInvalid({ detail: snapshot.error.message, action: 'keep-running-children-hold-spawns' }));
        return;
      }
      await recordApplied(key);
      log(settingsChanged({}));
    };

    const evaluate = async (): Promise<void> => {
      if (draining || role === 'retiring') return;
      try {
        await evaluateOnce();
      } catch (error) {
        reportReadFailure(error);
      }
    };

    const startWatch = (initialKey: string): SettingsWatch | undefined => {
      if (options.watchSettings === false || role === 'retiring') return undefined;
      lastEvaluatedKey = initialKey;
      settingsWatcher = watchSettings({
        directory: path.dirname(homePaths.settingsFile),
        file: path.basename(homePaths.settingsFile),
        debounceMs: intervals.settingsDebounceMs,
        pollMs: intervals.settingsPollMs,
        changeKey,
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
      timers,
      logger,
      recordStop: (values) => writeStopRecord(own.stopRecord, own.generation, values, lockMechanism),
      inspector,
      ...omitUndefined({ markerPorts: options.markerPorts }),
      stopReason: () => {
        if (role !== 'starting') return 'shutdown';
        return superseded ? 'superseded' : 'unpromoted';
      },
      beginDraining: () => {
        if (role === 'starting' && !ended) log(startUnpromoted({ generation: own.generation, reason: 'stopped' }));
        draining = true;
        setPhase('draining');
        launchController.abort();
        lifetime.abort();
        settingsWatcher?.stop();
        successor.stop();
        if (pollTimer !== undefined) timers.clearTimeout(pollTimer);
        if (promotionBoundTimer !== undefined) timers.clearTimeout(promotionBoundTimer);
        pollTimer = undefined;
        promotionBoundTimer = undefined;
      },
      awaitBackground: async () => {
        await Promise.all([launchPromise, publishPromise, pollPromise, reaperPromise, settingsWatcher?.idle()]);
      },
      closeControl: async () => {
        await server?.close();
      },
      releaseLock: () => lock.release(),
      onFatal: (error) => reportBackground(error, 'shutdown'),
    });

    const valuesOfStop = (given: StopValues | undefined): StopValues | undefined => {
      if (shutdown.mode() !== 'idle') return given;
      const values = given ?? stopValues.read();
      stopBoundMs = daemonStopBoundMs(values);
      return values;
    };
    const close = (values?: StopValues): Promise<SupervisorCloseResult> => {
      void shutdown.close(valuesOfStop(values));
      return shutdown.closed;
    };
    const abort = (values?: StopValues): Promise<SupervisorCloseResult> => {
      void shutdown.abort(valuesOfStop(values));
      return shutdown.closed;
    };

    requestShutdown = (values?: StopValues): void => {
      if (options.onShutdownRequested === undefined) void close(values);
      else options.onShutdownRequested(values);
    };

    options.signal?.throwIfAborted();
    server = await startControlServer({
      ...omitUndefined({ startSignal: options.signal }),
      socketPath: own.sockets.supervisor,
      timers,
      health,
      credential: async (name, capability, signal) => {
        if (capability === undefined || !gateway.holdsCapability(capability)) return { kind: 'refused' };
        const loaded = await settings.loadOrKeep(signal).catch((error: unknown) => {
          if (!signal.aborted) reportReadFailure(error);
          throw error;
        });
        if (!handedCredentialNames(loaded.settings).includes(name)) return { kind: 'refused' };
        const value = env[name];
        return value === undefined || value === '' ? { kind: 'unset' } : { kind: 'value', value };
      },
      onShutdownRequested: (values) => requestShutdown(values),
      onIgnoredStopValues: (reason) => log(settingsWarning({ detail: `the stop values of the shutdown request were malformed and were ignored: ${reason}` })),
      onError: (error) => reportBackground(error, 'control-server'),
      ...lockOptions,
    });

    await recordApplied(await changeKey());
    const ready: ReadyFields = { service: SUPERVISOR_SERVICE, pid: process.pid, version: options.version, socketPath: own.sockets.supervisor, startedAt };
    announceReady(ready, options.stdout);

    const reapOwnMarkers = async (): Promise<{ reaped: number; kept: number }> =>
      (options.markerPorts?.reapMarkerDirectory ?? reapMarkerDirectory)({
        dir: paths.markers.daemons,
        killGraceMs: DAEMON_MARKER_KILL_GRACE_MS,
        label: 'daemon',
        onWarning: (detail) => log(orphansWarning({ detail })),
        signal: launchSignal,
        timing: reapTiming,
        inspector,
        ...omitUndefined({ groupPort: options.markerPorts?.groupPort }),
      });

    armPromotionBound();
    armPoll();

    launchPromise = runLaunchTask({
      signal: launchSignal,
      logger,
      reapOwnMarkers,
      settings,
      changeKey,
      gateway,
      runtime,
      startWatch,
      evaluate,
    }).catch((error: unknown) => reportBackground(error, 'launch-task'));

    return { ready, health, close, abort, closed: shutdown.closed, fatal, role: () => role };
  } catch (error) {
    try {
      await server?.close();
    } finally {
      lock.release();
    }
    throw error;
  }
};
