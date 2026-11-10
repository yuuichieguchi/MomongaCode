import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, createPinnedDerivation, createStopValuesReader, createUserSettingsCache, derivedInputsOf, diskKeptRecords, readUserStopValues, keptSettingsDirectory, resolveNetwork, resolveTelemetrySettings } from '@momonga/config';
import type { ResolvedSettings } from '@momonga/config';
import { installTrust, trustFailureText } from '@momonga/foundation';
import {
  acquireProcessLock,
  announceReady,
  canonicalPath,
  createJsonLogger,
  createRedactor,
  createLockCapability,
  createRolePort,
  EXIT_RETIRED,
  fixedSocket,
  generationIsLive,
  generationLayout,
  generationOfDirectoryName,
  hostKernelLock,
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
  resolveKernelLock,
  ruleEnforcementOf,
  startDeadlineSignal,
  SETTINGS_APPLIED_ENV,
  systemClock,
  nodeFileSystem,
  nodeFileSystemSync,
  runtimeTeardownBudgetMs,
} from '@momonga/foundation';
import type { Clock, GenerationRole, JsonLogger, MomongaPaths, OutboundNetwork, ProcessLock, ReadyFields, RolePort, StopValues, TextStream } from '@momonga/foundation';
import { createTelemetry, exportersFor, openTraceStore, pageRunBodies, startBodyPurge } from '@momonga/observability';
import type { Telemetry, TraceStore } from '@momonga/observability';
import { DEFAULT_BWRAP_PATH, createBubblewrapSandbox, createPlaceholderJournal, createSeatbeltSandbox, createUnsandboxed, heldMountPoints, probeBubblewrap, recoverPlaceholders } from '@momonga/sandbox';
import { createNodeSkillFileSystem, createSkillLoader } from '@momonga/skills';
import type { Sandbox } from '@momonga/sandbox';
import { FIDELITY_PRUNE_BATCH_ROWS, isFatalStoreError, migrateRuntimeDatabase, openRuntimeStore } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { createRuleVerifier, installedRuleSolver } from './rule-verifier.ts';
import type { RuleSolverSource } from './rule-verifier.ts';
import { RetiringYield, ShellNotFoundError, createMarkerOwners, createPolicyFilesystem, nodeShellHost, resolveBashPath, sweepCallLocks } from '@momonga/tools';
import type { BundledRipgrepResolver, ShellHost } from '@momonga/tools';
import { createFsInstructionReader } from '@momonga/context';
import { createGatewayClient } from '../gateway-client.ts';
import { JOURNAL_THREAD_SILENCE_LIMIT_MS } from '../memory/journal-thread-limits.ts';
import { startJournalThread } from '../memory/journal-thread-client.ts';
import type { GatewayClient } from '../gateway-client.ts';
import { createTracerPort } from '../tracer.ts';
import { createRunNotifier } from '../service/notifier.ts';
import type { RunNotifier } from '../service/notifier.ts';
import { FACTS_SWEEP_BATCH_RUNS, FIDELITY_FOLD_VERSION } from '@momonga/protocol';
import type { DaemonCurrentFrame } from '@momonga/protocol';
import { startFactsSweeper } from '../service/facts-sweeper.ts';
import { startMemorySweeper } from '../service/memory-sweeper.ts';
import { createRunService } from '../service/service.ts';
import { createReflector } from '../memory/reflection.ts';
import { createMemoryUpkeepSchedule } from '../memory/upkeep-schedule.ts';
import { DAY_MS } from '@momonga/memory';
import { createRecordViews } from '../memory/views.ts';
import { TRACE_EVENT_TYPES, costBreakdownOf, reportCostOf, runlessTimingsOf, sideTimingsOfRun, traceCallsOf, traceEventsOf } from '../service/model-calls.ts';
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
import { createSkillsPort } from './skills-port.ts';
import { runTeardown } from './teardown.ts';
import type { TeardownStep } from './teardown.ts';
import { sweepSessionTmp, sweepSpawnTmp } from './tmp-sweep.ts';
import { reapToolMarkers } from './tool-markers.ts';
import { createToolRuntime } from './tool-runtime.ts';
import type { ToolRuntime } from './tool-runtime.ts';

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
  acquireLock?: (lockPath: string) => Promise<ProcessLock>;
  bundledRipgrep?: BundledRipgrepSource;
  ruleSolver?: RuleSolverSource;
  role?: RolePort;
  requestShutdown?: () => void;
};

export type BundledRipgrepSource = (paths: Pick<MomongaPaths, 'executables'>) => BundledRipgrepResolver;

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

const DEFAULT_SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';
const DEFAULT_LEASE_MS = 30_000;
const PLACEHOLDER_JOURNAL_DIRECTORY = 'placeholders';

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
  const sandboxExecPath = options.sandboxExecPath;
  const shellHost = options.shellHost ?? nodeShellHost();
  const clock = options.clock ?? systemClock;
  const redactor = createRedactor({ credentials: [] });
  const timers = options.timers ?? systemTimers;
  const logger = options.logger ?? createJsonLogger({ service: 'runtime', clock });
  const stdout = options.stdout ?? process.stdout;

  const startedAtMs = clock.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const canonicalHome = canonicalPath(home);
  const platform = options.platform ?? process.platform;
  const reapTiming = reapTimingOf(clock, timers);
  const onWarning = (message: string): void => logger.warn(message);
  const stopValuesReader = createStopValuesReader({ load: () => readUserStopValues(canonicalHome), onNotice: onWarning });
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

  const latchFatal = (error: Error): void => {
    if (phase === 'closed') return;
    logger.error('runtime.fatal', { err: error });
    if (fatalError !== undefined) return;
    fatalError = error;
    resolveFatal(error);
    if (phase === 'running') void abort();
    else if (phase === 'draining') requestAbort();
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
      await Promise.race([Promise.all(aborts), budget]);
    } finally {
      timers.clearTimeout(handle);
    }
    const stragglers = [...unsettled];
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
        Promise.allSettled(workers.map(({ worker }) => worker.stop())).then(() => 'drained' as const),
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

  try {
    const sharedPaths = momongaPaths(canonicalHome, platform, {});
    const paths = await step('dirs', async () => {
      await requireGenerationDirs(sharedPaths, options.generation);
      const scoped = scopeToGeneration(sharedPaths, options.generation);
      await ensureJobOutputDirectory(scoped.jobs);
      await fs.promises.mkdir(scoped.tmp.spawn, { recursive: true, mode: 0o700 });
      return scoped;
    });
    const own = generationLayout(canonicalHome, options.generation);
    const rolePort = options.role ?? createRolePort({ paths: sharedPaths, generation: options.generation, logger });
    await step('role', () => rolePort.refresh());
    const ignorableMarkerDirectories = async (): Promise<string[]> => {
      const directories = [paths.markers.root];
      for (const generation of (await nodeFileSystem.readdir(sharedPaths.markers.root)).map(generationOfDirectoryName)) {
        if (generation === undefined || generation === options.generation) continue;
        if (!(await generationIsLive(sharedPaths, generation, { lock: hostKernelLock() }))) directories.push(scopeToGeneration(sharedPaths, generation).markers.root);
      }
      return directories;
    };

    const lock: ProcessLock = await step('lock', async () => {
      try {
        return await (options.acquireLock ?? acquireProcessLock)(own.locks.runtime);
      } catch (error) {
        if (error instanceof ProcessLockHeldError && error.lockPath === own.locks.runtime) {
          throw new RuntimeAlreadyRunningError(error.message, error.lockPath, error.holderPid);
        }
        throw error;
      }
    });
    cleanups.push({ name: 'lock', run: () => lock.release() });

    const outboundNetworkOf = async (section: ResolvedSettings['network'], installSignal: AbortSignal): Promise<OutboundNetwork> => {
      const networkConfig = resolveNetwork(section, process.env);
      const trust = await installTrust(networkConfig, nodeFileSystem, { signal: installSignal });
      for (const failure of trust.failures) logger.warn(trustFailureText(failure));
      return { config: networkConfig, trust };
    };
    const { cache, settings } = await step('settings', async () => {
      const appliedRecord = process.env[SETTINGS_APPLIED_ENV];
      const created = createUserSettingsCache({ home: canonicalHome, onWarning, keptRecords: diskKeptRecords(nodeFileSystemSync, keptSettingsDirectory(canonicalHome)), ...(appliedRecord === undefined ? {} : { appliedRecord }) });
      const snapshot = created.snapshot();
      if ('error' in snapshot) throw snapshot.error;
      return { cache: created, settings: snapshot.settings };
    });

    const journalDirectory = path.join(paths.state, PLACEHOLDER_JOURNAL_DIRECTORY);
    const sandboxOf = async (kind: SandboxKind, deriveSignal: AbortSignal): Promise<Sandbox> => {
      if (kind === 'none') {
        const unsandboxed = createUnsandboxed({ killGraceMs: SANDBOX_KILL_GRACE_MS });
        logger.warn('sandbox is none: Bash asks before every command');
        return unsandboxed;
      }
      const required = kind === 'seatbelt' ? 'darwin' : 'linux';
      if (platform !== required) {
        throw new ConfigError(`sandbox "${kind}" is only available on ${required}; set "sandbox" in ${paths.settingsFile} to "none" to run without a sandbox (Bash will then ask before every command)`);
      }
      const launcherPath = sandboxExecPath ?? (kind === 'seatbelt' ? DEFAULT_SANDBOX_EXEC_PATH : DEFAULT_BWRAP_PATH);
      const launcherName = kind === 'seatbelt' ? 'sandbox-exec' : 'bwrap';
      try {
        await fs.promises.access(launcherPath, fs.constants.X_OK);
      } catch (error) {
        throw new ConfigError(
          `${launcherName} is not available at ${launcherPath}; set "sandbox": "none" in ${paths.settingsFile} to run without a sandbox (Bash will then ask before every command)`,
          { cause: error },
        );
      }
      if (kind === 'bubblewrap') {
        let shell: string;
        try {
          shell = resolveBashPath(shellHost.platform, { isExecutable: shellHost.isExecutable, env: process.env });
        } catch (error) {
          if (!(error instanceof ShellNotFoundError)) throw error;
          throw new ConfigError(error.message, { cause: error });
        }
        const probe = await probeBubblewrap(launcherPath, shell, { signal: deriveSignal });
        if (!probe.ok) {
          throw new ConfigError(
            `bwrap at ${launcherPath} cannot create a sandbox on this host: ${probe.stderr}; set "sandbox": "none" in ${paths.settingsFile} to run without a sandbox (Bash will then ask before every command)`,
          );
        }
        return createBubblewrapSandbox({ bwrapPath: launcherPath, tmpRoot: paths.tmp.spawn, killGraceMs: SANDBOX_KILL_GRACE_MS, journal: createPlaceholderJournal(journalDirectory), holders: () => heldMountPoints() });
      }
      return createSeatbeltSandbox({ sandboxExecPath: launcherPath, tmpRoot: paths.tmp.spawn, killGraceMs: SANDBOX_KILL_GRACE_MS });
    };
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
    await step('sandbox', async () => {
      (await sandboxes.admit(startDeadlineSignal(signal))).release();
    });

    await step('mcp-markers', async () => {
      const reapStop = new AbortController();
      const bound = timers.setTimeout(() => reapStop.abort(), markerReapClockBoundMs(MARKER_REAP_KILL_GRACE_MS));
      const reapSignal = signal === undefined ? reapStop.signal : AbortSignal.any([signal, reapStop.signal]);
      try {
        await reapMarkerDirectory({ dir: paths.markers.mcp, killGraceMs: MARKER_REAP_KILL_GRACE_MS, label: 'mcp', onWarning, timing: reapTiming, signal: reapSignal });
      } finally {
        timers.clearTimeout(bound);
      }
    });

    const { notifier, store, journalThread } = await step('store', async () => {
      migrateRuntimeDatabase(paths.databases.runtime);
      const { dev, ino } = fs.statSync(paths.databases.runtime);
      const startedThread = await startJournalThread({ databasePath: paths.databases.runtime, identity: { dev, ino }, silenceLimitMs: JOURNAL_THREAD_SILENCE_LIMIT_MS });
      const createdNotifier = createRunNotifier();
      try {
        const opened = openRuntimeStore({
          path: paths.databases.runtime,
          home: canonicalHome,
          clock,
          leaseMs,
          maxAttempts: STORE_MAX_ATTEMPTS,
          maxTotalAttempts: STORE_MAX_TOTAL_ATTEMPTS,
          generation: options.generation,
          onCommit: createdNotifier.onCommit,
          preparer: startedThread,
        });
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

    const lockCapability = createLockCapability({ proofDir: paths.lockProof });
    const kernelLock = await resolveKernelLock(paths.callLocks, { capability: lockCapability });

    await step('tool-markers', async () => {
      await reapToolMarkers({ dir: paths.markers.tools, store, killGraceMs: MARKER_REAP_KILL_GRACE_MS, onWarning, timing: reapTiming, signal, event: 'startup', owners: markerOwners });
      await sweepCallLocks({ dir: paths.callLocks, mechanism: kernelLock });
    });

    const traceStore: TraceStore = await step('trace-store', () => openTraceStore({ path: paths.traces.runtime, clock }));
    cleanups.push({ name: 'trace-store', run: () => traceStore.close() });

    const contentRetentionMs = resolveTelemetrySettings(settings.telemetry).contentRetentionDays * DAY_MS;
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

    type TracedTelemetry = { telemetry: Telemetry; tracer: TracerPort };
    const telemetries = createPinnedDerivation<TracedTelemetry>({
      cache,
      signal: lifetime.signal,
      inputsOf: derivedInputsOf('D2'),
      derive: async (current, _previous, deriveSignal) => {
        const resolved = resolveTelemetrySettings(current.telemetry);
        const outbound = await outboundNetworkOf(current.network, deriveSignal);
        const telemetry = createTelemetry({
          serviceName: 'momonga-runtime',
          serviceVersion: version,
          clock,
          store: traceStore,
          exporters: exportersFor(current.telemetry, outbound),
          captureMessageContent: resolved.captureMessageContent,
          contentRetentionMs: resolved.contentRetentionDays * DAY_MS,
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
      const composition = createSettingsComposition({ home: canonicalHome, platform, cache, store });
      const mcpNetwork = await outboundNetworkOf(settings.network, startDeadlineSignal(undefined));
      const runtime: ToolRuntime = createToolRuntime({
        owners: markerOwners,
        lockCapability,
        kernelLock,
        paths,
        network: mcpNetwork,
        sharedPaths,
        generation: options.generation,
        role: rolePort,
        onJobSettled: () => onWorkEnded(),
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
        ...(options.bundledRipgrep === undefined ? {} : { bundledRipgrep: options.bundledRipgrep(paths) }),
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
      const memories = createMemoryPort({ store, settings: composition.settings, evidenceRun: evidenceRunFor });
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
          await reapToolMarkers({ dir: paths.markers.tools, store, killGraceMs: MARKER_REAP_KILL_GRACE_MS, onWarning, timing: reapTiming, signal: stop.signal, event: 'shutdown', owners: toolRuntime.owners });
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

    const runService = await step('service', () =>
      createRunService({
        ...(signal === undefined ? {} : { startSignal: signal }),
        store,
        clock,
        redactor,
        home: canonicalHome,
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
        protectedRootAreas: protectedRootAreasOf(paths, canonicalHome),
        notifier,
        modelListing: (requestSignal) => gatewayClient.listing({ signal: requestSignal }),
        modelCapabilities: (model, requestSignal) => gatewayClient.capabilities(model, { signal: requestSignal }),
        sessionCreateSettings: async (cwd, requestSignal) => {
          const admittedSettings = await settingsComposition.sessionCreateSettings(cwd);
          await settingsComposition.admitted(async () => (await sandboxes.admit(requestSignal)).release());
          return admittedSettings;
        },
        sessionReadSettings: settingsComposition.sessionReadSettings,
        skills: skillsPort,
        agents: agentsPort,
        userInput: createUserInputPort({
          tools: toolRuntime.port,
          policy: toolRuntime.userPolicy,
          store,
          settings: settingsComposition.settings,
          clock,
          home: canonicalHome,
          unsandboxed: createUnsandboxed({ killGraceMs: SANDBOX_KILL_GRACE_MS }),
        }),
        evidenceRun: evidenceRunFor,
        defaults: RUNTIME_DEFAULTS,
        timers,
        cancelUpstream: tracker.cancel,
        releaseStopped: createStoppedRunReleaser({ store, tools: toolRuntime.port }),
        runTrace: async (runId) => {
          await telemetries.current().telemetry.forceFlush();
          const trace = runTraceOf(traceStore, runId);
          return trace === undefined
            ? undefined
            : { ...trace, calls: traceCallsOf(await store.readModelCallEvents(runId)), events: traceEventsOf(store.readRunEventsOfTypes(runId, [...TRACE_EVENT_TYPES])) };
        },
        runCost: (runs, signal, includeRunless) => gatewayClient.cost(runs, signal, includeRunless),
        runCostBreakdown: (runs, signal, includeRunless) =>
          costBreakdownOf({
            runIds: runs.map((run) => run.runId),
            recordsOf: (runId) => store.readModelCallEvents(runId),
            sideTimingsOf: (runId) => sideTimingsOfRun(store, runId),
            runlessTimingsOf: () => runlessTimingsOf(store),
            fetchPage: (runIds, cursor, limit) => gatewayClient.billedCalls(runIds, cursor, limit, includeRunless, signal),
          }),
        reportCost: (runIds, signal) => reportCostOf({ runIds, fetchPage: (ids, cursor, limit) => gatewayClient.billedCalls(ids, cursor, limit, false, signal) }),
        runTraceContent: async (runId, after, limit) => {
          await telemetries.current().telemetry.forceFlush();
          return pageRunBodies(traceStore, runId, after, limit);
        },
        mcp: toolRuntime.mcpAdmin,
        markerOwners: toolRuntime.owners,
        role: rolePort,
        work: { steps: stepsInFlight, jobs: () => toolRuntime.jobs.liveCount() },
        ignorableMarkerDirectories,
        onRequestEnd: () => onWorkEnded(),
        onError: (error) => logger.error('service error', { err: asError(error) }),
        onFatal: latchFatal,
      }),
    );
    service = runService;
    cleanups.push({ name: 'service', run: () => (retireFrame === undefined ? runService.close() : runService.retire(retireFrame.current)) });

    const ruleVerifier = createRuleVerifier({
      host: options.ruleSolver === undefined ? installedRuleSolver(import.meta.url) : options.ruleSolver(paths),
      fs: createPolicyFilesystem(),
      paths,
      timers,
    });
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
          instructionReader: createFsInstructionReader(),
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
        if ((await inspectProcessLock(generationLayout(canonicalHome, generation).locks.runtime)).state !== 'free') return true;
      }
      return false;
    };
    const fidelityBound = async (): Promise<number | undefined> => {
      let bound = FIDELITY_FOLD_VERSION;
      for (const listed of await listGenerations(sharedPaths, { lock: hostKernelLock() })) {
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
        maxAttempts: STORE_MAX_ATTEMPTS,
        attemptTimeoutMs: RUNTIME_DEFAULTS.runTimeoutMs,
        timers,
        random: Math.random,
      });
      const upkeepSchedule = createMemoryUpkeepSchedule({
        store,
        clock,
        views: memoryViews,
        batchSize: MEMORY_UPKEEP_BATCH_MARKS,
        pageRows: MEMORY_PAGE_ROWS,
        passIntervalMs: DAY_MS,
        forgetAfterDays: async (project) =>
          (project === null ? settingsComposition.takeUserSnapshot().settings.memory : await settingsComposition.settings.memory({ cwd: project })).forgetAfterDays,
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
              await sweepSessionTmp({ root: paths.tmp.sessions, store, now: clock.now(), onWarning });
              return 'done';
            },
          },
          {
            name: 'spawn-scratch',
            intervalMs: SESSION_TMP_SWEEP_MS,
            run: async (): Promise<ServingTaskOutcome> => {
              await sweepSpawnTmp({ dir: paths.tmp.spawn, onWarning });
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
                sandboxes.current().sandbox.sweep?.();
              } catch (error) {
                failures.push(error);
              }
              try {
                await reapToolMarkers({
                  dir: paths.markers.tools,
                  store,
                  killGraceMs: MARKER_REAP_KILL_GRACE_MS,
                  onWarning,
                  timing: reapTiming,
                  signal: sweepStop.signal,
                  event: 'sweep',
                  owners: toolRuntime.owners,
                });
              } catch (error) {
                failures.push(error);
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
              for (const leftover of recoverPlaceholders(createPlaceholderJournal(journalDirectory)).removed) logger.warn(`removed the empty placeholder ${leftover} that a killed runtime left in a workspace`);
              return 'done';
            },
          },
        ],
      });
      const stopKillWatch = notifier.subscribe(() => toolRuntime.jobs.stopKillRequested());
      let announcedRetiring = false;
      const checkRetireExit = (): void => {
        if (phase !== 'running' || lifecycle !== undefined || rolePort.current() !== 'retiring') return;
        if (stepsInFlight() > 0 || toolRuntime.jobs.liveCount() > 0 || requireService().openRequests() > 0) return;
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

    const ready: ReadyFields = await step('ready', () => {
      signal?.throwIfAborted();
      try {
        store.checkIdentity();
      } catch (error) {
        if (!isFatalStoreError(error)) throw error;
        latchFatal(asError(error));
      }
      if (fatalError !== undefined) throw fatalError;
      const fields: ReadyFields = { service: 'runtime', pid: process.pid, version, socketPath: own.sockets.runtime, startedAt };
      announceReady(fields, stdout);
      logger.info('runtime ready');
      phase = 'running';
      if (fatalError !== undefined) void abort();
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
