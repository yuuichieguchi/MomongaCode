import path from 'node:path';
import { loadProjectMandate, createPinnedDerivation, createStopValuesReader, createUserSettingsCache, derivedInputsOf, diskKeptRecords, keptSettingsDirectory, stopValuesOfSettings, resolveRetentionSettings, resolveTelemetrySettings } from '@momonga/config';
import type { ResolvedSettings, StopValuesReader } from '@momonga/config';
import { createSandboxOf, placeholderJournalDirectoryOf } from './sandbox-of.ts';
import { canonicalHomeOf, installTrust, settledOrAborted, layoutProcessInspector, busyTimeoutMs, unixSocketPolicyOf } from '@momonga/foundation';
import {
  acquireProcessLock,
  announceReady,
  createJsonLogger,
  createRedactor,
  createRolePort,
  EXIT_RETIRED,
  fixedSocket,
  generationIsLive,
  generationLayout,
  endpointScopeOf,
  generationOfDirectoryName,
  inspectProcessLock,
  listGenerations,
  momongaPaths,
  readCurrentGeneration,
  requireGenerationDirs,
  scopeToGeneration,
  SWEEP_INTERVAL_MS,
  ProcessLockHeldError,
  markerReapClockBoundMs,
  reapMarkerDirectory,
  ruleEnforcementOf,
  hostPaths,
  startDeadlineSignal,
  SETTINGS_APPLIED_ENV,
  systemClock,
  nodeFileSystem,
  systemRandom,
  runtimeTeardownBudgetMs,
} from '@momonga/foundation';
import type { Clock, GenerationRole, HelperSelf, JsonLogger, MomongaPaths, OutboundNetwork, ProcessLock, ReadyFields, RolePort, StopValues, TextStream, LayoutLocks } from '@momonga/foundation';
import { createTelemetry, exportersFor, openTraceStore, pageRunBodies, startBodyPurge } from '@momonga/observability';
import type { Telemetry, TraceStore } from '@momonga/observability';
import { DEFAULT_BWRAP_PATH, DEFAULT_SANDBOX_EXEC_PATH, bubblewrapPresent, childProtectionFor, protectionCommandOf, createPlaceholderJournal, createUnsandboxed, recoverPlaceholders } from '@momonga/sandbox';
import { createNodeSkillFileSystem, createSkillLoader } from '@momonga/skills';
import { unaskedCommandsFor } from '@momonga/policy';
import { DERIVED_CATCH_UP_PAGES, FIDELITY_PRUNE_BATCH_ROWS, isFatalStoreError, migrateRuntimeDatabase, openRuntimeStore } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { productRuleVerifier } from './rule-verifier.ts';
import { folderPolicyVerification, mandateRunVerification } from './folder-verification.ts';
import type { MandateRunSources } from './folder-verification.ts';
import { supervisedGatewayStanding } from './supervised-gateway.ts';
import type { RuleSolverSource } from './rule-verifier.ts';
import { RetiringYield, createMarkerOwners, createPolicyFilesystem, nodeShellHost, operationCatalogueFacts, sweepCallLocks } from '@momonga/tools';
import type { BundledRipgrepResolver, ShellHost } from '@momonga/tools';
import { createFsInstructionReader } from '@momonga/context';
import { createGatewayClient } from '../gateway-client.ts';
import { JOURNAL_THREAD_SILENCE_LIMIT_MS } from '../memory/journal-thread-limits.ts';
import { startJournalThread } from '../memory/journal-thread-client.ts';
import type { GatewayClient } from '../gateway-client.ts';
import { createTracerPort } from '../tracer.ts';
import { createRunNotifier } from '../service/notifier.ts';
import type { RunNotifier } from '../service/notifier.ts';
import { FACTS_SWEEP_BATCH_RUNS, FIDELITY_FOLD_VERSION, RULE_VERIFY_BUDGET_MS } from '@momonga/protocol';
import type { DaemonCurrentFrame } from '@momonga/protocol';
import { recomputeFactsOf, startFactsSweeper } from '../service/facts-sweeper.ts';
import { startMemorySweeper } from '../service/memory-sweeper.ts';
import { createRunService } from '../service/service.ts';
import { createReflector } from '../memory/reflection.ts';
import { createMemoryUpkeepSchedule } from '../memory/upkeep-schedule.ts';
import { DAY_MS } from '@momonga/memory';
import { createRecordViews } from '../memory/views.ts';
import { TRACE_EVENT_TYPES, costBreakdownOf, costReportOf, readRecordedCosts, reportCostOf, runlessTimingsOf, sideTimingsOfRun, traceCallsOf, traceEventsOf } from '../service/model-calls.ts';
import { runTraceOf } from '../service/trace-view.ts';
import type { RunService } from '../service/service.ts';
import { systemTimers } from '../service/timers.ts';
import type { ServiceTimers } from '../service/timers.ts';
import { heartbeatMsFor } from '../worker/heartbeat.ts';
import { retireDecisionOf } from '../worker/gateway-policy.ts';
import { createWorker } from '../worker/worker.ts';
import type { Worker } from '../worker/types.ts';
import { asError } from './as-error.ts';
import { JOB_RECONCILE_BATCH_JOBS } from './background-jobs.ts';
import { ensureJobOutputDirectory } from './job-output-file.ts';
import { createServingTasks } from './serving-tasks.ts';
import type { ServingTaskOutcome } from './serving-tasks.ts';
import { createCancelUpstream } from './cancel-upstream.ts';
import { createStoppedRunReleaser } from './release-stopped.ts';
import type { CancelUpstreamTracker } from './cancel-upstream.ts';
import {
  CANCEL_UPSTREAM_SETTLE_MS,
  GATEWAY_CANCEL_TIMEOUT_MS,
  IDEMPOTENCY_PURGE_MS,
  MARKER_REAP_KILL_GRACE_MS,
  MEMORY_UPKEEP_BATCH_MARKS,
  MEMORY_PAGE_ROWS,
  RUNTIME_ABORT_BUDGET_MS,
  RUNTIME_TEARDOWN_BUDGET_MS,
  SANDBOX_KILL_GRACE_MS,
  SESSION_STATE_SWEEP_MS,
  SESSION_TMP_SWEEP_MS,
  STORE_IDENTITY_CHECK_MS,
  STORE_MAX_ATTEMPTS,
  STORE_MAX_TOTAL_ATTEMPTS,
  TOOL_MARKER_SWEEP_MS,
} from './constants.ts';
import { RUNTIME_DEFAULTS } from './defaults.ts';
import { RuntimeAlreadyRunningError } from './errors.ts';
import { startPeriodic } from './periodic.ts';
import type { Periodic } from './periodic.ts';
import { protectedRootAreasOf } from './protected-areas.ts';
import { reapTimingOf } from './reap-timing.ts';
import type { SandboxKind } from './sandbox-kind.ts';
import type { SandboxBinding, TracerLeases, TracerPort } from '../ports.ts';
import { createSettingsComposition } from './settings-port.ts';
import { createGovernancePort } from '../governance/governance-port.ts';
import { createEvidenceRunner } from './evidence-run.ts';
import { createHistoryPort } from './history-port.ts';
import { createUserInputPort } from './user-input.ts';
import { createMemoryPort } from './memory-port.ts';
import { createAgentsPort } from './agents-port.ts';
import { createChildRuns } from './child-runs.ts';
import { permissionRulesFor } from '../governance/rules.ts';
import { createSkillsPort } from './skills-port.ts';
import { runTeardown } from './teardown.ts';
import type { TeardownStep } from './teardown.ts';
import { sweepSessionTmp, sweepSpawnTmp } from './tmp-sweep.ts';
import { reapToolMarkers } from './tool-markers.ts';
import { createNetworkDerivation } from './network-derivation.ts';
import { createToolRuntime } from './tool-runtime.ts';

const USER_COMMANDS_STRAGGLER = 'user-commands';
import type { ToolRuntime, ToolRuntimeOptions } from './tool-runtime.ts';

export type StartRuntimeProcessOptions = {
  home: string;
  generation: number;
  version: string;
  clock?: Clock;
  timers?: ServiceTimers;
  logger?: JsonLogger;
  stdout?: TextStream;
  gatewaySocketPath?: string;
  sandboxExecPath?: string;
  shellHost?: ShellHost;
  platform?: NodeJS.Platform;
  workerCount?: number;
  leaseMs?: number;
  signal?: AbortSignal;
  locks: LayoutLocks;
  stopValues?: StopValuesReader;
  acquireLock?: (lockPath: string) => Promise<ProcessLock>;
  bundledRipgrep?: BundledRipgrepSource;
  helperSelf?: HelperSelf;
  ruleSolver?: RuleSolverSource;
  socketGuard?: SocketGuardSource;
  role?: RolePort;
  requestShutdown?: () => void;
  createAdminPool?: ToolRuntimeOptions['createAdminPool'];
};

export type BundledRipgrepSource = (paths: Pick<MomongaPaths, 'executables'>, locks: LayoutLocks) => BundledRipgrepResolver;

export type SocketGuardSource = (paths: Pick<MomongaPaths, 'executables'>, locks: LayoutLocks) => () => Promise<string>;

export type RuntimeCloseResult = {
  clean: boolean;
  fatal?: Error;
  abandoned: string[];
  stragglers: string[];
  exitCode?: number;
};

export type RuntimeProcess = {
  ready: ReadyFields;
  sandbox: SandboxKind;
  close(values?: StopValues): Promise<RuntimeCloseResult>;
  abort(values?: StopValues): Promise<RuntimeCloseResult>;
  role(): GenerationRole;
  fatal: Promise<Error>;
};

type Phase = 'starting' | 'running' | 'draining' | 'aborting' | 'tearingDown' | 'closed';

type StartedWorker = { id: string; worker: Worker };

export const DEFAULT_LEASE_MS = 30_000;
const SPAWN_DIRECTORY_MODE = 0o700;

const assertPositiveInteger = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer, got ${value}`);
};

const assertAbsolute = (name: string, value: string): void => {
  if (!path.isAbsolute(value)) throw new TypeError(`${name} must be an absolute path, got ${value}`);
};

export const startRuntimeProcess = async (options: StartRuntimeProcessOptions): Promise<RuntimeProcess> => {
  const { home, version, signal } = options;
  assertAbsolute('home', home);
  if (options.gatewaySocketPath !== undefined) assertAbsolute('gatewaySocketPath', options.gatewaySocketPath);
  const workerCount = options.workerCount ?? 1;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  assertPositiveInteger('workerCount', workerCount);
  assertPositiveInteger('leaseMs', leaseMs);
  const storeBusyWaitMs = busyTimeoutMs(heartbeatMsFor(leaseMs));
  const sandboxExecPath = options.sandboxExecPath;
  const shellHost = options.shellHost ?? nodeShellHost();
  const clock = options.clock ?? systemClock;
  const redactor = createRedactor({ credentials: [] });
  const timers = options.timers ?? systemTimers;
  const logger = options.logger ?? createJsonLogger({ service: 'runtime', clock });
  const stdout = options.stdout ?? process.stdout;

  const startedAtMs = clock.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const canonicalHome = await canonicalHomeOf(home, hostPaths(startDeadlineSignal(signal)));
  const platform = options.platform ?? process.platform;
  const reapTiming = reapTimingOf(clock, timers);
  const onWarning = (message: string): void => logger.warn(message);
  const stopValuesReader = options.stopValues ?? createStopValuesReader({ onNotice: onWarning });
  const valuesOfStop = (given: StopValues | undefined): StopValues => given ?? stopValuesReader.read();
  let stopMcpCloseGraceMs: number | undefined;

  const cleanups: TeardownStep[] = [];
  const lifetime = new AbortController();
  const markerOwners = createMarkerOwners();
  const workers: StartedWorker[] = [];
  const periodics: Periodic[] = [];
  let workersSettled = false;

  let phase: Phase = 'starting';
  let fatalError: Error | undefined;
  let resolveFatal: (error: Error) => void = () => undefined;
  const fatal = new Promise<Error>((resolve) => {
    resolveFatal = resolve;
  });
  let requestAbort: () => void = () => undefined;
  const abortRequested = new Promise<void>((resolve) => {
    requestAbort = resolve;
  });
  let lifecycle: Promise<RuntimeCloseResult> | undefined;
  let service: RunService | undefined;
  let retireFrame: { current: DaemonCurrentFrame | undefined } | undefined;
  let onWorkEnded: () => void = () => undefined;
  const stepsInFlight = (): number => workers.reduce((sum, { worker }) => sum + worker.claimsInFlight(), 0);

  const abortOnLatchedFatal = (): void => {
    if (fatalError === undefined) return;
    if (phase === 'running') void abort();
    else if (phase === 'draining') requestAbort();
  };

  const latchFatal = (error: Error): void => {
    if (phase === 'closed') return;
    logger.error('runtime.fatal', { err: error });
    if (fatalError !== undefined) return;
    fatalError = error;
    resolveFatal(error);
    abortOnLatchedFatal();
  };

  const report = (error: unknown): void => {
    if (isFatalStoreError(error)) latchFatal(asError(error));
    else logger.error('runtime error', { err: asError(error) });
  };

  const abortWorkers = async (): Promise<string[]> => {
    workersSettled = true;
    const unsettled = new Set(workers.map((entry) => entry.id));
    const aborts = workers.map(({ id, worker }) =>
      worker.abort('shutdown').then(
        () => void unsettled.delete(id),
        (error: unknown) => {
          logger.error('worker abort failed', { err: asError(error), workerId: id });
          unsettled.delete(id);
        },
      ),
    );
    let handle: unknown;
    const budget = new Promise<void>((resolve) => {
      handle = timers.setTimeout(resolve, RUNTIME_ABORT_BUDGET_MS);
    });
    try {
      await Promise.race([Promise.all([...aborts, ...(service === undefined ? [] : [service.userCommands.abortAll('shutdown')])]), budget]);
    } finally {
      timers.clearTimeout(handle);
    }
    const stragglers = [...unsettled, ...(service !== undefined && service.userCommands.inFlight() > 0 ? [USER_COMMANDS_STRAGGLER] : [])];
    if (stragglers.length > 0) logger.warn('abort.stragglers', { count: stragglers.length, ids: stragglers });
    return stragglers;
  };

  const drainWorkers = async (drainTimeoutMs: number): Promise<'drained' | 'timeout' | 'abort'> => {
    let handle: unknown;
    const expired = new Promise<'timeout'>((resolve) => {
      handle = timers.setTimeout(() => resolve('timeout'), drainTimeoutMs);
    });
    try {
      return await Promise.race([
        Promise.allSettled([...workers.map(({ worker }) => worker.stop()), ...(service === undefined ? [] : [service.userCommands.ended()])]).then(() => 'drained' as const),
        expired,
        abortRequested.then(() => 'abort' as const),
      ]);
    } finally {
      timers.clearTimeout(handle);
    }
  };

  const teardown = (values: StopValues, failureEvent?: string): Promise<string[]> => {
    stopMcpCloseGraceMs = values.mcpCloseGraceMs;
    lifetime.abort(new Error('the runtime is closing'));
    return runTeardown({ steps: [...cleanups].reverse(), budgetMs: runtimeTeardownBudgetMs(values.mcpCloseGraceMs), clock, timers, logger, ...(failureEvent === undefined ? {} : { failureEvent }) });
  };

  const mcpCloseGraceOfStop = (): number => {
    if (stopMcpCloseGraceMs === undefined) throw new Error('the MCP pools were closed before the stop that closes them took its values');
    return stopMcpCloseGraceMs;
  };

  const shutdown = async (abortFirst: boolean, values: StopValues): Promise<RuntimeCloseResult> => {
    let stragglers: string[] = [];
    let phaseFailed = false;
    try {
      phase = abortFirst ? 'aborting' : 'draining';
      service?.beginDraining();
      const outcome = abortFirst ? 'abort' : await drainWorkers(values.drainTimeoutMs);
      if (outcome === 'drained') workersSettled = true;
      else {
        phase = 'aborting';
        stragglers = await abortWorkers();
      }
    } catch (error) {
      phaseFailed = true;
      logger.error('shutdown failed', { err: asError(error) });
    }
    phase = 'tearingDown';
    const abandoned = await teardown(values);
    phase = 'closed';
    const result: RuntimeCloseResult = {
      clean: !phaseFailed && abandoned.length === 0 && stragglers.length === 0 && fatalError === undefined,
      abandoned,
      stragglers,
      ...(fatalError === undefined ? {} : { fatal: fatalError }),
    };
    return result;
  };

  const retire = async (sharedPaths: MomongaPaths): Promise<RuntimeCloseResult> => {
    phase = 'tearingDown';
    let current: DaemonCurrentFrame | undefined;
    try {
      const read = await readCurrentGeneration(sharedPaths);
      current = read === undefined ? undefined : { generation: read.generation, version: read.version };
    } catch (error) {
      logger.warn('generation.current_unreadable', { err: asError(error) });
    }
    retireFrame = { current };
    const abandoned = await teardown(valuesOfStop(undefined));
    phase = 'closed';
    const clean = abandoned.length === 0 && fatalError === undefined;
    return { clean, abandoned, stragglers: [], ...(clean ? { exitCode: EXIT_RETIRED } : {}), ...(fatalError === undefined ? {} : { fatal: fatalError }) };
  };

  const close = (values?: StopValues): Promise<RuntimeCloseResult> => {
    lifecycle ??= shutdown(false, valuesOfStop(values));
    return lifecycle;
  };

  const abort = (values?: StopValues): Promise<RuntimeCloseResult> => {
    if (lifecycle === undefined) lifecycle = shutdown(true, valuesOfStop(values));
    else requestAbort();
    return lifecycle;
  };

  const step = async <T>(name: string, run: () => T | Promise<T>): Promise<T> => {
    signal?.throwIfAborted();
    logger.debug('startup.step', { step: name });
    return run();
  };

  const { capability: lockCapability, mechanism: kernelLock } = options.locks;
  const inspector = layoutProcessInspector(lockCapability);

  try {
    const sharedPaths = momongaPaths(canonicalHome, platform, process.env);
    const paths = await step('dirs', async () => {
      await requireGenerationDirs(sharedPaths, options.generation);
      const scoped = scopeToGeneration(sharedPaths, options.generation);
      await ensureJobOutputDirectory(nodeFileSystem, scoped.jobs);
      await nodeFileSystem.mkdir(scoped.tmp.spawn, SPAWN_DIRECTORY_MODE);
      return scoped;
    });
    const own = generationLayout(canonicalHome, options.generation, platform, await endpointScopeOf(sharedPaths, platform, { files: nodeFileSystem, random: systemRandom, lock: kernelLock }));
    const rolePort = options.role ?? createRolePort({ paths: sharedPaths, generation: options.generation, logger });
    await step('role', () => rolePort.refresh());
    const ignorableMarkerDirectories = async (signal: AbortSignal): Promise<string[]> => {
      const directories = [paths.markers.root];
      for (const generation of (await settledOrAborted(nodeFileSystem.readdir(sharedPaths.markers.root), signal)).map(generationOfDirectoryName)) {
        if (generation === undefined || generation === options.generation) continue;
        if (!(await settledOrAborted(generationIsLive(sharedPaths, generation, { lock: kernelLock }), signal))) directories.push(scopeToGeneration(sharedPaths, generation).markers.root);
      }
      return directories;
    };

    const lock: ProcessLock = await step('lock', async () => {
      try {
        return await (options.acquireLock ?? ((lockPath: string) => acquireProcessLock(lockPath, undefined, { mechanism: kernelLock })))(own.locks.runtime);
      } catch (error) {
        if (error instanceof ProcessLockHeldError && error.lockPath === own.locks.runtime) {
          throw new RuntimeAlreadyRunningError(error.message, error.lockPath, error.holderPid);
        }
        throw error;
      }
    });
    cleanups.push({ name: 'lock', run: () => lock.release() });

    const { cache, settings } = await step('settings', async () => {
      const appliedRecord = process.env[SETTINGS_APPLIED_ENV];
      const created = createUserSettingsCache({
        home: canonicalHome,
        onWarning,
        keptRecords: diskKeptRecords(nodeFileSystem, systemRandom, keptSettingsDirectory(canonicalHome), kernelLock),
        onLoaded: (loaded) => stopValuesReader.remember(stopValuesOfSettings(loaded.settings)),
        ...(appliedRecord === undefined ? {} : { appliedRecord }),
      });
      const snapshot = await created.load(startDeadlineSignal(signal));
      if ('error' in snapshot) throw snapshot.error;
      return { cache: created, settings: snapshot.settings };
    });

    const journalDirectory = placeholderJournalDirectoryOf(paths);
    const { helperSelf } = options;
    const bubblewrap = platform === 'linux' && (await bubblewrapPresent(DEFAULT_BWRAP_PATH, (file) => nodeFileSystem.access(file, 'execute')));
    const noneProtection = childProtectionFor({ sandbox: 'none', home: canonicalHome, platform, env: process.env, bubblewrap });
    const sandboxOf = createSandboxOf({
      platform,
      paths,
      env: process.env,
      shellHost,
      kernelLock,
      journalDirectory,
      noneProtection,
      warn: (text) => logger.warn(text),
      ...(sandboxExecPath === undefined ? {} : { sandboxExecPath }),
      ...(options.socketGuard === undefined ? {} : { socketGuard: options.socketGuard(paths, options.locks) }),
      ...(helperSelf === undefined ? {} : { helperSelf }),
    });
    const sandboxes = createPinnedDerivation<SandboxBinding>({
      cache,
      signal: lifetime.signal,
      inputsOf: derivedInputsOf('D3'),
      derive: async (current, _previous, deriveSignal) => {
        const sandbox = await sandboxOf(current.sandbox, deriveSignal);
        return { sandbox, ruleEnforcement: ruleEnforcementOf(sandbox.kind) };
      },
      retire: (binding) => binding.sandbox.sweep?.(),
      onWarning,
    });
    cleanups.push({ name: 'sandbox', run: () => sandboxes.retireAll() });
    await step('sandbox', async () => {
      (await sandboxes.admit(startDeadlineSignal(signal))).release();
    });

    await step('mcp-markers', async () => {
      const reapStop = new AbortController();
      const bound = timers.setTimeout(() => reapStop.abort(), markerReapClockBoundMs(MARKER_REAP_KILL_GRACE_MS));
      const reapSignal = signal === undefined ? reapStop.signal : AbortSignal.any([signal, reapStop.signal]);
      try {
        await reapMarkerDirectory({ dir: paths.markers.mcp, killGraceMs: MARKER_REAP_KILL_GRACE_MS, label: 'mcp', onWarning, timing: reapTiming, signal: reapSignal, inspector, occasion: 'startup' });
      } finally {
        timers.clearTimeout(bound);
      }
    });

    const { notifier, store, journalThread } = await step('store', async () => {
      migrateRuntimeDatabase(paths.databases.runtime, storeBusyWaitMs);
      const { dev, ino } = await nodeFileSystem.stat(paths.databases.runtime);
      const startedThread = await startJournalThread({ databasePath: paths.databases.runtime, lock: kernelLock, busyTimeoutMs: storeBusyWaitMs, identity: { dev, ino }, silenceLimitMs: JOURNAL_THREAD_SILENCE_LIMIT_MS });
      const createdNotifier = createRunNotifier();
      try {
        const opened = openRuntimeStore({
          path: paths.databases.runtime,
          home: canonicalHome,
          lock: kernelLock,
          busyTimeoutMs: storeBusyWaitMs,
          clock,
          leaseMs,
          maxAttempts: STORE_MAX_ATTEMPTS,
          maxTotalAttempts: STORE_MAX_TOTAL_ATTEMPTS,
          generation: options.generation,
          onCommit: createdNotifier.onCommit,
          preparer: startedThread,
          unaskedCommands: unaskedCommandsFor(platform),
          fileSystem: nodeFileSystem,
          random: systemRandom,
        });
        try {
          await opened.blobs.prepare();
        } catch (error) {
          opened.close();
          throw error;
        }
        return { notifier: createdNotifier, store: opened, journalThread: startedThread };
      } catch (error) {
        await startedThread.close();
        throw error;
      }
    });
    cleanups.push({
      name: 'store',
      run: async () => {
        try {
          store.close();
        } finally {
          await journalThread.close();
        }
      },
    });

    await step('tool-markers', async () => {
      await reapToolMarkers({ dir: paths.markers.tools, inspector, store, killGraceMs: MARKER_REAP_KILL_GRACE_MS, onWarning, timing: reapTiming, signal, event: 'startup', owners: markerOwners });
      await sweepCallLocks({ dir: paths.callLocks, mechanism: kernelLock });
    });

    const traceStore: TraceStore = await step('trace-store', () => openTraceStore({ path: paths.traces.runtime, clock, busyTimeoutMs: storeBusyWaitMs }));
    cleanups.push({ name: 'trace-store', run: () => traceStore.close() });

    const contentRetentionMs = resolveRetentionSettings(settings.retention).days * DAY_MS;
    let bodyPurge: { stop(): void } | undefined;
    const applyBodyPurge = (role: GenerationRole): void => {
      if (role === 'serving') {
        bodyPurge ??= startBodyPurge({ store: traceStore, timers, report, legacyRetentionMs: contentRetentionMs });
        return;
      }
      bodyPurge?.stop();
      bodyPurge = undefined;
    };
    cleanups.push({ name: 'body-purge', run: () => bodyPurge?.stop() });

    const networks = createNetworkDerivation({
      cache,
      signal: lifetime.signal,
      env: process.env,
      install: (config, installSignal) => installTrust(config, nodeFileSystem, { signal: installSignal }),
      onWarning: (message) => logger.warn(message),
    });

    type TracedTelemetry = { telemetry: Telemetry; tracer: TracerPort };
    const telemetries = createPinnedDerivation<TracedTelemetry>({
      cache,
      signal: lifetime.signal,
      inputsOf: derivedInputsOf('D2'),
      derive: async (current, _previous, deriveSignal) => {
        const resolved = resolveTelemetrySettings(current.telemetry);
        const { outbound } = await networks.networkOf(deriveSignal);
        const telemetry = createTelemetry({
          serviceName: 'momonga-runtime',
          serviceVersion: version,
          clock,
          store: traceStore,
          exporters: exportersFor(current.telemetry, outbound),
          captureMessageContent: resolved.captureMessageContent,
          contentRetentionMs: resolveRetentionSettings(current.retention).days * DAY_MS,
        });
        return { telemetry, tracer: createTracerPort(telemetry) };
      },
      retire: async ({ telemetry }) => {
        try {
          await telemetry.forceFlush();
        } finally {
          await telemetry.shutdown();
        }
      },
      onWarning,
    });
    await step('telemetry', async () => {
      (await telemetries.admit(startDeadlineSignal(undefined))).release();
    });
    cleanups.push({ name: 'telemetry', run: () => telemetries.retireAll() });
    const tracers: TracerLeases = {
      acquire: async (tracerSignal) => {
        const lease = await telemetries.acquire(tracerSignal);
        return { value: lease.value.tracer, release: lease.release };
      },
    };

    const gatewayClient: GatewayClient = await step('gateway-client', () =>
      createGatewayClient({
        resolveSocket: fixedSocket(options.gatewaySocketPath ?? own.sockets.gateway),
        clock,
        timers,
        version,
        cancelTimeoutMs: GATEWAY_CANCEL_TIMEOUT_MS,
      }),
    );
    cleanups.push({ name: 'gateway-client', run: () => gatewayClient.destroy() });

    const ports = await step('ports', async () => {
      const composition = createSettingsComposition({ home: canonicalHome, platform, cache, store, lock: kernelLock });
      const runtime: ToolRuntime = createToolRuntime({
        version,
        mcpLaunch: {
          protection: noneProtection,
          commandOf: (argv) => protectionCommandOf(noneProtection, { platform, argv, scratch: [], sandboxExecPath: DEFAULT_SANDBOX_EXEC_PATH, bwrapPath: DEFAULT_BWRAP_PATH }),
        },
        owners: markerOwners,
        lockCapability,
        kernelLock,
        paths,
        network: networks.networkOf,
        sharedPaths,
        generation: options.generation,
        role: rolePort,
        onJobSettled: () => onWorkEnded(),
        onAuthorizationEnded: () => onWorkEnded(),
        ...(options.createAdminPool === undefined ? {} : { createAdminPool: options.createAdminPool }),
        home: canonicalHome,
        store,
        notifier,
        clock,
        timers,
        logger,
        report,
        sandboxes,
        shellHost,
        settings: composition,
        reapTiming,
        leaseMs,
        heartbeatMs: heartbeatMsFor(leaseMs),
        ...(options.bundledRipgrep === undefined ? {} : { bundledRipgrep: options.bundledRipgrep(paths, options.locks) }),
        ...(options.helperSelf === undefined ? {} : { helperSelf: options.helperSelf }),
      });
      const tracker: CancelUpstreamTracker = createCancelUpstream({ store, gatewayClient, timers });
      const skills = createSkillsPort({
        loader: createSkillLoader({ home: canonicalHome, fileSystem: createNodeSkillFileSystem() }),
        settings: composition.settings,
      });
      const evidenceRunFor = createEvidenceRunner({
        paths,
        home: canonicalHome,
        fs: createPolicyFilesystem(),
        sandboxes,
        env: process.env['PATH'] === undefined ? {} : { PATH: process.env['PATH'] },
        reap: { timing: reapTiming, inspector: runtime.inspector },
        owners: runtime.owners,
        onWarning,
      });
      const memories = createMemoryPort({ platform, store, settings: composition.settings, evidenceRun: evidenceRunFor });
      const history = createHistoryPort({ store, settings: composition.settings, clock, home: canonicalHome, redactor, enforcement: () => sandboxes.current().ruleEnforcement });
      const governance = createGovernancePort({ store, settings: composition.settings });
      const agents = createAgentsPort({
        home: canonicalHome,
        fileSystem: createNodeSkillFileSystem(),
        settings: composition.settings,
        runs: createChildRuns({
          store,
          modelViews: async () => {
            try {
              return (await gatewayClient.listing({ signal: lifetime.signal })).views;
            } catch (error) {
              if ((await retireDecisionOf(error, rolePort)) === 'retire-yield') throw new RetiringYield();
              throw error;
            }
          },
        }),
      });
      return { composition, runtime, tracker, skills, memories, history, governance, agents, evidenceRunFor };
    });
    const {
      composition: settingsComposition,
      runtime: toolRuntime,
      tracker,
      skills: skillsPort,
      memories: memoriesPort,
      history: historyPort,
      governance: governancePort,
      agents: agentsPort,
      evidenceRunFor,
    } = ports;
    await step('background-jobs', () => toolRuntime.jobs.reconcileOrphans());
    cleanups.push({
      name: 'tool-markers',
      run: async () => {
        const stop = new AbortController();
        const handle = timers.setTimeout(() => stop.abort(), RUNTIME_TEARDOWN_BUDGET_MS);
        try {
          await reapToolMarkers({ dir: paths.markers.tools, inspector, store, killGraceMs: MARKER_REAP_KILL_GRACE_MS, onWarning, timing: reapTiming, signal: stop.signal, event: 'shutdown', owners: toolRuntime.owners });
        } finally {
          timers.clearTimeout(handle);
        }
      },
    });
    cleanups.push({ name: 'background-jobs', run: () => toolRuntime.jobs.stopAll() });
    cleanups.push({
      name: 'mcp-pools',
      run: async () => {
        const graceMs = mcpCloseGraceOfStop();
        await Promise.all([toolRuntime.mcpPools.closeAll(graceMs), toolRuntime.mcpAdmin.close(graceMs)]);
      },
    });
    cleanups.push({ name: 'cancel-upstream', run: () => tracker.settle(CANCEL_UPSTREAM_SETTLE_MS) });

    const ruleVerifier = productRuleVerifier({ solver: options.ruleSolver, paths, locks: options.locks, timers, shellHost, env: process.env, clock, budgetMs: RULE_VERIFY_BUDGET_MS });
    const verificationSources: MandateRunSources = {
      verifier: ruleVerifier,
      ruleVerdicts: store.ruleVerdicts,
      home: canonicalHome,
      sessionsRoot: paths.tmp.sessions,
      folder: async (cwd: string, requestSignal: AbortSignal) => {
        const { defaultMode, additionalDirectories } = await settingsComposition.sessionReadSettings(cwd, requestSignal);
        const rules = await permissionRulesFor({ store, settings: settingsComposition.settings, clock, home: canonicalHome }, { cwd }, requestSignal);
        const lease = await sandboxes.acquire(requestSignal);
        const { ruleEnforcement, sandbox } = lease.value;
        lease.release();
        const { sandboxUnixSockets } = (await settingsComposition.userSnapshot(requestSignal)).settings;
        return { rules, additionalDirectories, enforcement: ruleEnforcement, unixSockets: unixSocketPolicyOf(sandbox.kind, sandboxUnixSockets.allow), ...(defaultMode === undefined ? {} : { defaultMode }) };
      },
      catalogue: operationCatalogueFacts,
      retrySignal: lifetime.signal,
      onRetryFailure: report,
    };
    const mandateVerification = mandateRunVerification(verificationSources);
    const runService = await step('service', () =>
      createRunService({
        ...(signal === undefined ? {} : { startSignal: signal }),
        store,
        clock,
        redactor,
        home: canonicalHome,
        lock: kernelLock,
        version,
        socketPath: own.sockets.runtime,
        pid: process.pid,
        startedAt,
        sandboxKind: async (healthSignal) => {
          const lease = await sandboxes.acquire(healthSignal);
          const { kind } = lease.value.sandbox;
          lease.release();
          return kind;
        },
        protectedRootAreas: protectedRootAreasOf(paths),
        notifier,
        modelListing: (requestSignal) => gatewayClient.listing({ signal: requestSignal }),
        delegation: {
          settings: async (requestSignal) => {
            const { limits, ceilings, mandates } = (await settingsComposition.userSnapshot(requestSignal)).settings;
            return { ...(limits === undefined ? {} : { limits }), ...(ceilings === undefined ? {} : { ceilings }), ...(mandates === undefined ? {} : { mandates }) };
          },
          projectMandate: async (cwd, requestSignal) =>
            loadProjectMandate({ projectDir: cwd, trusted: await settingsComposition.trustOracle.isTrusted(cwd, requestSignal), approvals: (await settingsComposition.userSnapshot(requestSignal)).settings.projectApprovals, signal: requestSignal }),
          chainBilling: async (model, requestSignal) => {
            const { chain } = await gatewayClient.model(model, { signal: requestSignal });
            const quote = await gatewayClient.quote(model, { signal: requestSignal });
            return { metered: chain.some((member) => member.billed?.billing === 'metered'), priced: quote.priced };
          },
        },
        modelCapabilities: (model, requestSignal) => gatewayClient.capabilities(model, { signal: requestSignal }),
        sessionCreateSettings: async (cwd, requestSignal) => {
          const admittedSettings = await settingsComposition.sessionCreateSettings(cwd, requestSignal);
          await settingsComposition.admitted(async () => (await sandboxes.admit(requestSignal)).release());
          return admittedSettings;
        },
        sessionReadSettings: settingsComposition.sessionReadSettings,
        skills: skillsPort,
        agents: agentsPort,
        permissionRules: (session, requestSignal) => permissionRulesFor({ store, settings: settingsComposition.settings, clock, home: canonicalHome }, session, requestSignal),
        gatewayStanding: supervisedGatewayStanding(fixedSocket(own.sockets.supervisor)),
        policyVerification: folderPolicyVerification({ ...verificationSources, mandates: async (requestSignal) => (await settingsComposition.userSnapshot(requestSignal)).settings.mandates }),
        mandateVerification,
        userInput: createUserInputPort({
          tools: toolRuntime.port,
          policy: toolRuntime.userPolicy,
          store,
          settings: settingsComposition.settings,
          clock,
          home: canonicalHome,
          unsandboxed: createUnsandboxed({ killGraceMs: SANDBOX_KILL_GRACE_MS, protection: noneProtection, platform }),
          files: nodeFileSystem,
        }),
        evidenceRun: evidenceRunFor,
        skillFiles: nodeFileSystem,
        platform,
        defaults: RUNTIME_DEFAULTS,
        timers,
        cancelUpstream: tracker.cancel,
        releaseStopped: createStoppedRunReleaser({ store, tools: toolRuntime.port }),
        runTrace: async (runId, requestSignal) => {
          await settledOrAborted(telemetries.current().telemetry.flushLocal(), requestSignal);
          const trace = runTraceOf(traceStore, runId);
          return trace === undefined
            ? undefined
            : { ...trace, calls: traceCallsOf(await store.readModelCallEvents(runId)), events: traceEventsOf(store.readRunEventsOfTypes(runId, [...TRACE_EVENT_TYPES])) };
        },
        runCost: (runs, signal, includeRunless) =>
          costReportOf({
            runs,
            includeRunless,
            recordedCosts: () => readRecordedCosts(store, runs.map((run) => run.runId), includeRunless),
            fetchPage: (runIds, cursor, limit) => gatewayClient.billedCalls(runIds, cursor, limit, includeRunless, signal),
          }),
        runCostBreakdown: (runs, signal, includeRunless) =>
          costBreakdownOf({
            runIds: runs.map((run) => run.runId),
            recordsOf: (runId) => store.readModelCallEvents(runId),
            recordedCosts: () => readRecordedCosts(store, runs.map((run) => run.runId), includeRunless),
            sideTimingsOf: (runId) => sideTimingsOfRun(store, runId),
            runlessTimingsOf: () => runlessTimingsOf(store),
            fetchPage: (runIds, cursor, limit) => gatewayClient.billedCalls(runIds, cursor, limit, includeRunless, signal),
          }),
        recomputeFacts: (runIds, signal) => recomputeFactsOf(journalThread, runIds, signal),
        reportCost: async (runIds) => reportCostOf(store, runIds),
        runTraceContent: async (runId, after, limit, requestSignal) => {
          await settledOrAborted(telemetries.current().telemetry.flushLocal(), requestSignal);
          return pageRunBodies(traceStore, runId, after, limit);
        },
        mcp: toolRuntime.mcpAdmin,
        markerOwners: toolRuntime.owners,
        role: rolePort,
        work: { steps: stepsInFlight, jobs: () => toolRuntime.jobs.liveCount() },
        ignorableMarkerDirectories,
        files: nodeFileSystem,
        onRequestEnd: () => onWorkEnded(),
        onError: (error) => logger.error('service error', { err: asError(error) }),
        onFatal: latchFatal,
      }),
    );
    service = runService;
    cleanups.push({ name: 'service', run: () => (retireFrame === undefined ? runService.close() : runService.retire(retireFrame.current)) });

    await step('workers', () => {
      for (let index = 0; index < workerCount; index += 1) {
        const id = `runtime-${process.pid}-${startedAtMs}-${index}`;
        const worker = createWorker({
          store,
          gateway: gatewayClient,
          settings: settingsComposition.settings,
          skills: skillsPort,
          memories: memoriesPort,
          history: historyPort,
          governance: governancePort,
          agents: agentsPort,
          tools: toolRuntime.port,
          ruleVerifier,
          mandateVerification,
          tracers,
          clock,
          workerId: id,
          role: rolePort,
          onClaimSettled: () => onWorkEnded(),
          leaseMs,
          random: Math.random,
          platform,
          timers,
          defaults: RUNTIME_DEFAULTS.limits,
          home: canonicalHome,
          blobs: store.blobs,
          instructionReaderFor: (signal) => createFsInstructionReader(signal, platform),
          wake: notifier,
          onError: (error, context) =>
            logger.error('worker error', {
              err: asError(error),
              workerId: context.workerId,
              ...(context.runId === undefined ? {} : { runId: context.runId }),
            }),
          onFatal: latchFatal,
        });
        worker.start();
        workers.push({ id, worker });
        if (index === 0) {
          cleanups.push({
            name: 'workers',
            run: async () => {
              if (!workersSettled) await abortWorkers();
            },
          });
        }
      }
    });

    const requireService = (): RunService => runService;
    const otherRuntimeLive = async (): Promise<boolean> => {
      for (const generation of (await nodeFileSystem.readdir(sharedPaths.run)).map(generationOfDirectoryName)) {
        if (generation === undefined || generation === options.generation) continue;
        if ((await inspectProcessLock(generationLayout(canonicalHome, generation).locks.runtime, { mechanism: kernelLock })).state !== 'free') return true;
      }
      return false;
    };
    const fidelityBound = async (): Promise<number | undefined> => {
      let bound = FIDELITY_FOLD_VERSION;
      for (const listed of await listGenerations(sharedPaths, { lock: kernelLock })) {
        if (!listed.live || listed.generation === options.generation) continue;
        if (listed.record.kind !== 'record') return undefined;
        bound = Math.min(bound, listed.record.record.foldVersion);
      }
      return bound;
    };

    await step('timers', async () => {
      const memoryViews = createRecordViews({ store, evidenceRun: evidenceRunFor });
      const reflector = createReflector({
        store,
        gateway: gatewayClient,
        settings: settingsComposition.settings,
        clock,
        role: rolePort,
        isIdle: () => phase === 'running' && rolePort.current() === 'serving' && !store.hasActiveRun(),
        evidenceRun: evidenceRunFor,
        platform,
        maxAttempts: STORE_MAX_ATTEMPTS,
        attemptTimeoutMs: RUNTIME_DEFAULTS.runTimeoutMs,
        timers,
        random: Math.random,
        defaults: RUNTIME_DEFAULTS.limits,
      });
      const upkeepSchedule = createMemoryUpkeepSchedule({
        store,
        clock,
        fileSystem: nodeFileSystem,
        views: memoryViews,
        batchSize: MEMORY_UPKEEP_BATCH_MARKS,
        pageRows: MEMORY_PAGE_ROWS,
        passIntervalMs: DAY_MS,
        forgetAfterDays: async (project) =>
          (project === null ? settingsComposition.takeUserSnapshot().settings.memory : await settingsComposition.settings.memory({ cwd: project }, lifetime.signal)).forgetAfterDays,
        onSkipped: (project) => logger.warn(`memory upkeep skipped the project ${project}: the folder no longer exists`),
      });
      const sweepStop = new AbortController();
      const servingTasks = createServingTasks({
        clock,
        report,
        loops: [
          {
            start: () => {
              const sweeper = startMemorySweeper({
                timers,
                intervalMs: SWEEP_INTERVAL_MS,
                upkeep: (sweepSignal) => upkeepSchedule.tick(sweepSignal),
                reflect: (sweepSignal) => reflector.runOne(sweepSignal),
                onError: report,
              });
              return { stop: () => sweeper.close() };
            },
          },
          {
            start: () => {
              const sweeper = startFactsSweeper({ store, thread: journalThread, timers, intervalMs: SWEEP_INTERVAL_MS, batchSize: FACTS_SWEEP_BATCH_RUNS, onError: report });
              return { stop: () => sweeper.close() };
            },
          },
        ],
        tasks: [
          {
            name: 'idempotency-purge',
            intervalMs: IDEMPOTENCY_PURGE_MS,
            run: (): ServingTaskOutcome => {
              store.idempotency.purgeExpired(clock.now());
              return 'done';
            },
          },
          {
            name: 'session-scratch',
            intervalMs: SESSION_TMP_SWEEP_MS,
            run: async (): Promise<ServingTaskOutcome> => {
              await sweepSessionTmp({ root: paths.tmp.sessions, store, now: clock.now(), onWarning, lock: kernelLock });
              return 'done';
            },
          },
          {
            name: 'spawn-scratch',
            intervalMs: SESSION_TMP_SWEEP_MS,
            run: async (): Promise<ServingTaskOutcome> => {
              await sweepSpawnTmp({ dir: paths.tmp.spawn, onWarning, lock: kernelLock });
              return 'done';
            },
          },
          {
            name: 'call-locks',
            intervalMs: TOOL_MARKER_SWEEP_MS,
            lastRanAt: clock.now(),
            run: async (): Promise<ServingTaskOutcome> => {
              await sweepCallLocks({ dir: paths.callLocks, mechanism: kernelLock });
              return 'done';
            },
          },
          {
            name: 'derived-catch-up',
            intervalMs: IDEMPOTENCY_PURGE_MS,
            run: async (): Promise<ServingTaskOutcome> => ((await store.catchUpDerived(DERIVED_CATCH_UP_PAGES)) ? 'done' : 'again'),
          },
          {
            name: 'fidelity-prune',
            intervalMs: IDEMPOTENCY_PURGE_MS,
            run: async (): Promise<ServingTaskOutcome> => {
              const bound = await fidelityBound();
              if (bound === undefined) return 'again';
              return store.pruneFidelityVerdicts(bound) < FIDELITY_PRUNE_BATCH_ROWS ? 'done' : 'again';
            },
          },
          {
            name: 'tool-markers',
            intervalMs: TOOL_MARKER_SWEEP_MS,
            lastRanAt: clock.now(),
            run: async (): Promise<ServingTaskOutcome> => {
              const failures: unknown[] = [];
              try {
                await sandboxes.current().sandbox.sweep?.();
              } catch (error) {
                failures.push(error);
              }
              const tickStop = new AbortController();
              const tickBound = timers.setTimeout(() => tickStop.abort(new Error(`the tool marker sweep did not end within ${TOOL_MARKER_SWEEP_MS} ms`)), TOOL_MARKER_SWEEP_MS);
              try {
                await reapToolMarkers({
                  dir: paths.markers.tools,
                  inspector,
                  store,
                  killGraceMs: MARKER_REAP_KILL_GRACE_MS,
                  onWarning,
                  timing: reapTiming,
                  signal: AbortSignal.any([sweepStop.signal, tickStop.signal]),
                  event: 'sweep',
                  owners: toolRuntime.owners,
                });
              } catch (error) {
                failures.push(error);
              } finally {
                timers.clearTimeout(tickBound);
              }
              if (failures.length === 1) throw failures[0];
              if (failures.length > 1) throw new AggregateError(failures, 'the sandbox sweep and the tool marker sweep both failed');
              return 'done';
            },
          },
          {
            name: 'job-reconcile',
            intervalMs: SWEEP_INTERVAL_MS,
            lastRanAt: clock.now(),
            run: async (): Promise<ServingTaskOutcome> => {
              await toolRuntime.jobs.reconcileOrphans({ batch: JOB_RECONCILE_BATCH_JOBS });
              return 'done';
            },
          },
          {
            name: 'placeholder-recovery',
            intervalMs: Number.POSITIVE_INFINITY,
            run: async (): Promise<ServingTaskOutcome> => {
              if (platform !== 'linux') return 'done';
              if (await otherRuntimeLive()) return 'again';
              const { sandbox } = sandboxes.current();
              const recovered = await (sandbox.recover === undefined ? recoverPlaceholders(createPlaceholderJournal(journalDirectory)) : sandbox.recover());
              for (const leftover of recovered.removed) logger.warn(`removed the empty placeholder ${leftover} that a killed runtime left in a workspace`);
              for (const leftover of recovered.unrecovered) logger.warn(`left ${leftover} in place: a killed runtime may have created it as a placeholder before recording which file it was, so it is not removed; delete it yourself if you did not create it`);
              return 'done';
            },
          },
        ],
      });
      const stopKillWatch = notifier.subscribe(() => toolRuntime.jobs.stopKillRequested());
      let announcedRetiring = false;
      const checkRetireExit = (): void => {
        if (phase !== 'running' || lifecycle !== undefined || rolePort.current() !== 'retiring') return;
        if (stepsInFlight() > 0 || toolRuntime.jobs.liveCount() > 0 || toolRuntime.mcpAdmin.pendingAuthorizations() > 0 || requireService().openRequests() > 0 || requireService().userCommands.inFlight() > 0) return;
        requireService().stopListening();
        logger.info('generation.retired', { data: { generation: options.generation } });
        lifecycle = retire(sharedPaths);
        options.requestShutdown?.();
      };
      onWorkEnded = () => {
        if (phase !== 'running' || rolePort.current() !== 'retiring') return;
        if (!announcedRetiring) {
          announcedRetiring = true;
          logger.info('generation.retiring', { data: { generation: options.generation } });
        }
        if (stepsInFlight() === 0) {
          toolRuntime.sessionStates.evictAll();
          void toolRuntime.mcpPools.closeAll(valuesOfStop(undefined).mcpCloseGraceMs).catch(report);
        }
        checkRetireExit();
      };
      const applyRole = async (role: GenerationRole): Promise<void> => {
        requireService().applyRole();
        applyBodyPurge(role);
        await servingTasks.tick(role);
        if (role === 'retiring') onWorkEnded();
      };
      await applyRole(rolePort.current());
      periodics.push(
        startPeriodic({ intervalMs: SWEEP_INTERVAL_MS, run: async () => applyRole(await rolePort.refresh()), timers, report }),
        startPeriodic({ intervalMs: SESSION_STATE_SWEEP_MS, run: () => {
            toolRuntime.sessionStates.evictIdle(clock.now());
          }, timers, report }),
        startPeriodic({ intervalMs: STORE_IDENTITY_CHECK_MS, run: () => store.checkIdentity(), timers, report }),
      );
      cleanups.push({
        name: 'timers',
        run: async () => {
          sweepStop.abort();
          stopKillWatch();
          await Promise.all([servingTasks.close(), ...periodics.map((periodic) => periodic.stop())]);
        },
      });
    });

    const ready: ReadyFields = await step('ready', async () => {
      signal?.throwIfAborted();
      try {
        await store.checkIdentity();
      } catch (error) {
        if (!isFatalStoreError(error)) throw error;
        latchFatal(asError(error));
      }
      if (fatalError !== undefined) throw fatalError;
      const fields: ReadyFields = { service: 'runtime', pid: process.pid, version, socketPath: own.sockets.runtime, startedAt };
      announceReady(fields, stdout);
      logger.info('runtime ready');
      phase = 'running';
      abortOnLatchedFatal();
      return fields;
    });

    return { ready, sandbox: settings.sandbox, close, abort, role: () => rolePort.current(), fatal };
  } catch (error) {
    phase = 'tearingDown';
    await teardown(valuesOfStop(undefined), 'startup.cleanup_failed');
    phase = 'closed';
    throw error;
  }
};
