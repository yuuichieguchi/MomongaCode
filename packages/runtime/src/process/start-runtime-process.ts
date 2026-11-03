import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, createUserSettingsCache } from '@momonga/config';
import {
  acquireProcessLock,
  announceReady,
  canonicalPath,
  createJsonLogger,
  createRedactor,
  ensureMomongaDirs,
  momongaPaths,
  ProcessLockHeldError,
  RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS,
  reapMarkerDirectory,
  ruleEnforcementOf,
  systemClock,
} from '@momonga/foundation';
import type { Clock, JsonLogger, ProcessLock, ReadyFields, TextStream } from '@momonga/foundation';
import { createTelemetry, exportersFor, openTraceStore } from '@momonga/observability';
import type { Telemetry, TraceStore } from '@momonga/observability';
import { DEFAULT_BWRAP_PATH, createBubblewrapSandbox, createPlaceholderJournal, createSeatbeltSandbox, createUnsandboxed, heldMountPoints, probeBubblewrap, recoverPlaceholders } from '@momonga/sandbox';
import { createNodeSkillFileSystem, createSkillLoader } from '@momonga/skills';
import type { Sandbox } from '@momonga/sandbox';
import { isFatalStoreError, openRuntimeStore } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { ShellNotFoundError, clearCallLocks, createPolicyFilesystem, nodeShellHost, resolveBashPath } from '@momonga/tools';
import type { ShellHost } from '@momonga/tools';
import { createFsInstructionReader } from '@momonga/context';
import { createGatewayClient } from '../gateway-client.ts';
import { contributionAtTerminal } from '../memory/contribution.ts';
import type { GatewayClient } from '../gateway-client.ts';
import { createTracerPort } from '../tracer.ts';
import { createRunNotifier } from '../service/notifier.ts';
import type { RunNotifier } from '../service/notifier.ts';
import { startMemorySweeper } from '../service/memory-sweeper.ts';
import { SWEEP_INTERVAL_MS, createRunService } from '../service/service.ts';
import { createReflector } from '../memory/reflection.ts';
import { createMemoryUpkeepSchedule } from '../memory/upkeep-schedule.ts';
import { DAY_MS } from '@momonga/memory';
import { createRecordViews } from '../memory/views.ts';
import { costBreakdownOf, runlessTimingsOf, sideTimingsOfRun, traceCallsOf } from '../service/model-calls.ts';
import { runTraceOf } from '../service/trace-view.ts';
import type { RunService } from '../service/service.ts';
import { systemTimers } from '../service/timers.ts';
import type { ServiceTimers } from '../service/timers.ts';
import { heartbeatMsFor } from '../worker/heartbeat.ts';
import { createWorker } from '../worker/worker.ts';
import type { Worker } from '../worker/types.ts';
import { asError } from './as-error.ts';
import { createCancelUpstream } from './cancel-upstream.ts';
import { createStoppedRunReleaser } from './release-stopped.ts';
import type { CancelUpstreamTracker } from './cancel-upstream.ts';
import {
  CANCEL_UPSTREAM_SETTLE_MS,
  GATEWAY_CANCEL_TIMEOUT_MS,
  IDEMPOTENCY_PURGE_MS,
  MARKER_REAP_KILL_GRACE_MS,
  MEMORY_UPKEEP_BATCH_MARKS,
  MEMORY_UPKEEP_PAGE_ROWS,
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
import { createSettingsComposition } from './settings-port.ts';
import { createGovernancePort } from '../governance/governance-port.ts';
import { createEvidenceRunner } from './evidence-run.ts';
import { createHistoryPort } from './history-port.ts';
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
  drainTimeoutMs?: number;
  signal?: AbortSignal;
  acquireLock?: (lockPath: string) => Promise<ProcessLock>;
};

export type RuntimeCloseResult = {
  clean: boolean;
  fatal?: Error;
  abandoned: string[];
  stragglers: string[];
};

export type RuntimeProcess = {
  ready: ReadyFields;
  sandbox: SandboxKind;
  close(): Promise<RuntimeCloseResult>;
  abort(): Promise<RuntimeCloseResult>;
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
  const drainTimeoutMs = options.drainTimeoutMs ?? RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS;
  assertPositiveInteger('workerCount', workerCount);
  assertPositiveInteger('leaseMs', leaseMs);
  if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 0) {
    throw new RangeError(`drainTimeoutMs must be a non-negative integer, got ${drainTimeoutMs}`);
  }
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
  const reapTiming = reapTimingOf(clock, timers);
  const onWarning = (message: string): void => logger.warn(message);

  const cleanups: TeardownStep[] = [];
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

  const drainWorkers = async (): Promise<'drained' | 'timeout' | 'abort'> => {
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

  const teardown = (failureEvent?: string): Promise<string[]> =>
    runTeardown({ steps: [...cleanups].reverse(), budgetMs: RUNTIME_TEARDOWN_BUDGET_MS, clock, timers, logger, ...(failureEvent === undefined ? {} : { failureEvent }) });

  const shutdown = async (abortFirst: boolean): Promise<RuntimeCloseResult> => {
    let stragglers: string[] = [];
    let phaseFailed = false;
    try {
      phase = abortFirst ? 'aborting' : 'draining';
      service?.beginDraining();
      const outcome = abortFirst ? 'abort' : await drainWorkers();
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
    const abandoned = await teardown();
    phase = 'closed';
    const result: RuntimeCloseResult = {
      clean: !phaseFailed && abandoned.length === 0 && stragglers.length === 0 && fatalError === undefined,
      abandoned,
      stragglers,
      ...(fatalError === undefined ? {} : { fatal: fatalError }),
    };
    return result;
  };

  const close = (): Promise<RuntimeCloseResult> => {
    lifecycle ??= shutdown(false);
    return lifecycle;
  };

  const abort = (): Promise<RuntimeCloseResult> => {
    if (lifecycle === undefined) lifecycle = shutdown(true);
    else requestAbort();
    return lifecycle;
  };

  const step = async <T>(name: string, run: () => T | Promise<T>): Promise<T> => {
    signal?.throwIfAborted();
    logger.debug('startup.step', { step: name });
    return run();
  };

  try {
    const paths = await step('dirs', async () => {
      const resolved = momongaPaths(canonicalHome, process.platform, {});
      await ensureMomongaDirs(resolved);
      return resolved;
    });

    const lock: ProcessLock = await step('lock', async () => {
      try {
        return await (options.acquireLock ?? acquireProcessLock)(paths.locks.runtime);
      } catch (error) {
        if (error instanceof ProcessLockHeldError && error.lockPath === paths.locks.runtime) {
          throw new RuntimeAlreadyRunningError(error.message, error.lockPath, error.holderPid);
        }
        throw error;
      }
    });
    cleanups.push({ name: 'lock', run: () => lock.release() });

    const { cache, settings } = await step('settings', () => {
      const created = createUserSettingsCache({ home: canonicalHome, onWarning });
      const snapshot = created.snapshot();
      if ('error' in snapshot) throw snapshot.error;
      return { cache: created, settings: snapshot.settings };
    });

    const kind: SandboxKind = settings.sandbox;
    const sandbox: Sandbox = await step('sandbox', () => {
      const platform = options.platform ?? process.platform;
      const journalDirectory = path.join(paths.state, PLACEHOLDER_JOURNAL_DIRECTORY);
      if (platform === 'linux') {
        for (const leftover of recoverPlaceholders(createPlaceholderJournal(journalDirectory)).removed) logger.warn(`removed the empty placeholder ${leftover} that a killed runtime left in a workspace`);
      }
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
        fs.accessSync(launcherPath, fs.constants.X_OK);
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
        const probe = probeBubblewrap(launcherPath, shell);
        if (!probe.ok) {
          throw new ConfigError(
            `bwrap at ${launcherPath} cannot create a sandbox on this host: ${probe.stderr}; set "sandbox": "none" in ${paths.settingsFile} to run without a sandbox (Bash will then ask before every command)`,
          );
        }
        return createBubblewrapSandbox({ bwrapPath: launcherPath, tmpRoot: paths.tmp.spawn, killGraceMs: SANDBOX_KILL_GRACE_MS, journal: createPlaceholderJournal(journalDirectory), holders: () => heldMountPoints() });
      }
      return createSeatbeltSandbox({ sandboxExecPath: launcherPath, tmpRoot: paths.tmp.spawn, killGraceMs: SANDBOX_KILL_GRACE_MS });
    });

    await step('mcp-markers', async () => {
      await reapMarkerDirectory({ dir: paths.markers.mcp, killGraceMs: MARKER_REAP_KILL_GRACE_MS, label: 'mcp', onWarning, timing: reapTiming });
    });

    const { notifier, store } = await step('store', (): { notifier: RunNotifier; store: RuntimeStore } => {
      const createdNotifier = createRunNotifier();
      const opened = openRuntimeStore({
        path: paths.databases.runtime,
        home: canonicalHome,
        clock,
        leaseMs,
        maxAttempts: STORE_MAX_ATTEMPTS,
        maxTotalAttempts: STORE_MAX_TOTAL_ATTEMPTS,
        onCommit: createdNotifier.onCommit,
        contribution: contributionAtTerminal,
      });
      return { notifier: createdNotifier, store: opened };
    });
    cleanups.push({ name: 'store', run: () => store.close() });

    await step('tool-markers', async () => {
      await reapToolMarkers({ dir: paths.markers.tools, store, killGraceMs: MARKER_REAP_KILL_GRACE_MS, onWarning, timing: reapTiming });
      await clearCallLocks(paths.callLocks);
    });

    await step('tmp-sweep', async () => {
      await sweepSpawnTmp({ dir: paths.tmp.spawn, onWarning });
      await sweepSessionTmp({ root: paths.tmp.sessions, store, now: clock.now(), hasInMemoryState: () => false, onWarning });
    });

    const traceStore: TraceStore = await step('trace-store', () => openTraceStore({ path: paths.traces.runtime, clock }));
    cleanups.push({ name: 'trace-store', run: () => traceStore.close() });

    const telemetry: Telemetry = await step('telemetry', () =>
      createTelemetry({ serviceName: 'momonga-runtime', serviceVersion: version, clock, store: traceStore, exporters: exportersFor(settings.telemetry), captureMessageContent: settings.telemetry?.captureMessageContent === true }),
    );
    cleanups.push({
      name: 'telemetry',
      run: async () => {
        try {
          await telemetry.forceFlush();
        } finally {
          await telemetry.shutdown();
        }
      },
    });
    const tracer = createTracerPort(telemetry);

    const gatewayClient: GatewayClient = await step('gateway-client', () =>
      createGatewayClient({
        socketPath: options.gatewaySocketPath ?? paths.sockets.gateway,
        clock,
        timers,
        version,
        cancelTimeoutMs: GATEWAY_CANCEL_TIMEOUT_MS,
      }),
    );
    cleanups.push({ name: 'gateway-client', run: () => gatewayClient.destroy() });

    const ports = await step('ports', () => {
      const composition = createSettingsComposition({ home: canonicalHome, cache, store });
      const runtime: ToolRuntime = createToolRuntime({
        paths,
        home: canonicalHome,
        store,
        notifier,
        clock,
        timers,
        logger,
        report,
        sandbox,
        shellHost,
        settings: composition,
        reapTiming,
        leaseMs,
        heartbeatMs: heartbeatMsFor(leaseMs),
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
        sandbox,
        env: process.env['PATH'] === undefined ? {} : { PATH: process.env['PATH'] },
        enforcement: ruleEnforcementOf(sandbox.kind),
      });
      const memories = createMemoryPort({ store, settings: composition.settings, evidenceRun: (session) => evidenceRunFor(session.cwd) });
      const history = createHistoryPort({ store, settings: composition.settings, clock, home: canonicalHome, redactor, enforcement: ruleEnforcementOf(sandbox.kind) });
      const governance = createGovernancePort({ store, settings: composition.settings });
      const agents = createAgentsPort({
        home: canonicalHome,
        fileSystem: createNodeSkillFileSystem(),
        settings: composition.settings,
        runs: createChildRuns({ store, modelAliases: async () => (await gatewayClient.models()).map((model) => model.id) }),
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
    cleanups.push({ name: 'background-jobs', run: () => toolRuntime.jobs.stopAll() });
    cleanups.push({
      name: 'mcp-pools',
      run: async () => {
        await toolRuntime.mcpPools.closeAll();
        await toolRuntime.mcpAdmin.close();
      },
    });
    cleanups.push({ name: 'cancel-upstream', run: () => tracker.settle(CANCEL_UPSTREAM_SETTLE_MS) });

    const runService = await step('service', () =>
      createRunService({
        store,
        clock,
        redactor,
        home: canonicalHome,
        version,
        socketPath: paths.sockets.runtime,
        pid: process.pid,
        startedAt,
        sandboxKind: kind,
        protectedRootAreas: protectedRootAreasOf(paths, canonicalHome),
        notifier,
        modelAliases: async () => (await gatewayClient.models()).map((model) => model.id),
        modelCapabilities: (alias, signal) => gatewayClient.capabilities(alias, { signal }),
        sessionCreateSettings: settingsComposition.sessionCreateSettings,
        skills: skillsPort,
        agents: agentsPort,
        evidenceRun: evidenceRunFor,
        defaults: RUNTIME_DEFAULTS,
        timers,
        cancelUpstream: tracker.cancel,
        releaseStopped: createStoppedRunReleaser({ store, tools: toolRuntime.port }),
        runTrace: async (runId) => {
          await telemetry.forceFlush();
          const trace = runTraceOf(traceStore, runId);
          return trace === undefined ? undefined : { ...trace, calls: traceCallsOf(store.readModelCallEvents(runId)) };
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
        mcp: toolRuntime.mcpAdmin,
        onError: (error) => logger.error('service error', { err: asError(error) }),
        onFatal: latchFatal,
      }),
    );
    service = runService;
    cleanups.push({ name: 'service', run: () => runService.close() });

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
          tracer,
          clock,
          workerId: id,
          leaseMs,
          random: Math.random,
          platform: process.platform,
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

    await step('timers', () => {
      const memoryViews = createRecordViews({ store, evidenceRun: evidenceRunFor });
      const reflector = createReflector({
        store,
        gateway: gatewayClient,
        settings: settingsComposition.settings,
        clock,
        isIdle: () => phase === 'running' && !store.hasActiveRun(),
        evidenceRun: evidenceRunFor,
        maxAttempts: STORE_MAX_ATTEMPTS,
        random: Math.random,
      });
      const upkeepSchedule = createMemoryUpkeepSchedule({
        store,
        clock,
        views: memoryViews,
        batchSize: MEMORY_UPKEEP_BATCH_MARKS,
        pageRows: MEMORY_UPKEEP_PAGE_ROWS,
        passIntervalMs: DAY_MS,
        forgetAfterDays: async (project) =>
          (project === null ? settingsComposition.takeUserSnapshot().settings.memory : await settingsComposition.settings.memory({ cwd: project })).forgetAfterDays,
        onSkipped: (project) => logger.warn(`memory upkeep skipped the project ${project}: the folder no longer exists`),
      });
      const memorySweeper = startMemorySweeper({
        timers,
        intervalMs: SWEEP_INTERVAL_MS,
        upkeep: (sweepSignal) => upkeepSchedule.tick(sweepSignal),
        reflect: (sweepSignal) => reflector.runOne(sweepSignal),
        onError: report,
      });
      periodics.push(
        startPeriodic({ intervalMs: IDEMPOTENCY_PURGE_MS, run: () => {
            store.idempotency.purgeExpired(clock.now());
          }, timers, report }),
        startPeriodic({
          intervalMs: SESSION_TMP_SWEEP_MS,
          run: async () => {
            await sweepSessionTmp({
              root: paths.tmp.sessions,
              store,
              now: clock.now(),
              hasInMemoryState: (sessionId) => toolRuntime.sessionStates.has(sessionId),
              onWarning,
            });
          },
          timers,
          report,
        }),
        startPeriodic({ intervalMs: SESSION_STATE_SWEEP_MS, run: () => {
            toolRuntime.sessionStates.evictIdle(clock.now());
          }, timers, report }),
        startPeriodic({ intervalMs: STORE_IDENTITY_CHECK_MS, run: () => store.checkIdentity(), timers, report }),
        startPeriodic({
          intervalMs: TOOL_MARKER_SWEEP_MS,
          run: async () => {
            const failures: unknown[] = [];
            try {
              sandbox.sweep?.();
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
                scope: { deadLetterOnly: true, skipKeys: toolRuntime.inFlightKeys() },
              });
            } catch (error) {
              failures.push(error);
            }
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) throw new AggregateError(failures, 'the sandbox sweep and the tool marker sweep both failed');
          },
          timers,
          report,
        }),
      );
      cleanups.push({
        name: 'timers',
        run: async () => void (await Promise.all([memorySweeper.close(), ...periodics.map((periodic) => periodic.stop())])),
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
      const fields: ReadyFields = { service: 'runtime', pid: process.pid, version, socketPath: paths.sockets.runtime, startedAt };
      announceReady(fields, stdout);
      logger.info('runtime ready');
      phase = 'running';
      if (fatalError !== undefined) void abort();
      return fields;
    });

    return { ready, sandbox: kind, close, abort, fatal };
  } catch (error) {
    phase = 'tearingDown';
    await teardown('startup.cleanup_failed');
    phase = 'closed';
    throw error;
  }
};
