import http from 'node:http';
import path from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { canonicalPath, comparableContains, listenUnix, startDeadlineSignal } from '@momonga/foundation';
import { createMarkerOwners } from '@momonga/tools';
import type { MarkerOwners } from '@momonga/tools';
import type { Clock, Redactor } from '@momonga/foundation';
import type { Capabilities, CostBreakdownView, GatewayCostReportView, RunTraceView } from '@momonga/protocol';
import { isFatalStoreError } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { asError } from '../process/as-error.ts';
import type { SandboxKind } from '../process/sandbox-kind.ts';
import type { EvidenceRun } from '../memory/evidence.ts';
import type { AgentCatalogPort, SkillsPort, UserInputPort } from '../ports.ts';
import { createRunApp } from './app.ts';
import type { RunLimitDefaults, SessionCreateSettings } from './app.ts';
import type { McpAdminPort } from './input-routes.ts';
import type { RunNotifier } from './notifier.ts';
import { startDataVersionPoll } from './data-version-poll.ts';
import { SEARCH_INDEX_BATCH_RUNS, startSearchSweeper } from './search-sweeper.ts';
import { releaseStoppedRunsAtStartup, startApprovalSweeper } from './sweeper.ts';
import { startTerminalSweeper } from './terminal-sweeper.ts';
import { systemTimers } from './timers.ts';
import type { ServiceTimers } from './timers.ts';

export const SWEEP_INTERVAL_MS = 1000;

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TWO_MIB = 2 * 1024 * 1024;

export type RunServiceOptions = {
  startSignal?: AbortSignal;
  markerOwners?: MarkerOwners;
  store: RuntimeStore;
  clock: Clock;
  redactor: Redactor;
  home: string;
  version: string;
  socketPath: string;
  pid: number;
  startedAt: string;
  sandboxKind: (signal: AbortSignal) => Promise<SandboxKind>;
  protectedRootAreas: readonly string[];
  notifier: RunNotifier;
  modelAliases: () => Promise<readonly string[]>;
  modelCapabilities: (alias: string, signal: AbortSignal) => Promise<Capabilities>;
  sessionCreateSettings: (cwd: string, signal: AbortSignal) => Promise<SessionCreateSettings>;
  sessionReadSettings: (cwd: string) => Promise<SessionCreateSettings>;
  skills: SkillsPort;
  agents: AgentCatalogPort;
  userInput: UserInputPort;
  evidenceRun: (project: string) => EvidenceRun;
  defaults: { modelAlias: string; runTimeoutMs?: number; limits: RunLimitDefaults };
  timers?: ServiceTimers;
  keepAliveMs?: number;
  sweepIntervalMs?: number;
  dataVersionPollMs?: number;
  maxBodyBytes?: number;
  cancelUpstream?: (runId: string, signal: AbortSignal) => Promise<void>;
  releaseStopped(runId: string, signal: AbortSignal): Promise<void>;
  runTrace: (runId: string) => Promise<RunTraceView | undefined>;
  runCost: (runs: readonly { runId: string; sessionId: string }[], signal: AbortSignal, includeRunless: boolean) => Promise<{ report: GatewayCostReportView; text: string }>;
  runCostBreakdown: (runs: readonly { runId: string; sessionId: string }[], signal: AbortSignal, includeRunless: boolean) => Promise<{ breakdown: CostBreakdownView; text: string }>;
  mcp: McpAdminPort;
  onError?: (error: unknown) => void;
  onFatal?: (error: Error) => void;
};

export type RunService = { socketPath: string; beginDraining(): void; close(): Promise<void> };

const reportToStderr = (error: unknown): void => {
  console.error(error);
};

const assertInsideMomongaHome = (home: string, socketPath: string): void => {
  const canonicalHome = canonicalPath(home);
  const socketDirectory = canonicalPath(path.dirname(socketPath));
  const allowed = path.join(canonicalHome, '.momonga');
  if (!comparableContains(allowed, socketDirectory)) {
    throw new Error(`the run socket must live under ${allowed}, but ${socketPath} resolves to ${socketDirectory}`);
  }
};

const closeServer = (server: http.Server): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

export const createRunService = async (options: RunServiceOptions): Promise<RunService> => {
  if (!path.isAbsolute(options.home)) throw new TypeError(`home must be an absolute path, received ${JSON.stringify(options.home)}`);
  assertInsideMomongaHome(options.home, options.socketPath);

  const timers = options.timers ?? systemTimers;
  const onError = options.onError ?? reportToStderr;
  const { onFatal } = options;
  const report = (error: unknown): void => {
    if (onFatal !== undefined && isFatalStoreError(error)) onFatal(asError(error));
    else onError(error);
  };
  const closeController = new AbortController();
  let draining = false;
  const app = createRunApp({
    store: options.store,
    clock: options.clock,
    home: options.home,
    version: options.version,
    modelAliases: options.modelAliases,
    modelCapabilities: options.modelCapabilities,
    sessionCreateSettings: options.sessionCreateSettings,
    sessionReadSettings: options.sessionReadSettings,
    skills: options.skills,
    agents: options.agents,
    userInput: options.userInput,
    evidenceRun: options.evidenceRun,
    isDraining: () => draining,
    beginDraining: () => {
      draining = true;
    },
    health: { pid: options.pid, startedAt: options.startedAt, sandbox: options.sandboxKind },
    protectedRootAreas: options.protectedRootAreas,
    defaults: { modelAlias: options.defaults.modelAlias, runTimeoutMs: options.defaults.runTimeoutMs ?? SIX_HOURS_MS, limits: options.defaults.limits },
    notifier: options.notifier,
    timers,
    keepAliveMs: options.keepAliveMs ?? 15_000,
    maxBodyBytes: options.maxBodyBytes ?? TWO_MIB,
    closeSignal: closeController.signal,
    runTrace: options.runTrace,
    runCost: options.runCost,
    runCostBreakdown: options.runCostBreakdown,
    mcp: options.mcp,
    markerOwners: options.markerOwners ?? createMarkerOwners(),
    onError: report,
  });

  const server = http.createServer(getRequestListener((request, env) => app.fetch(request, env)));
  await listenUnix(server, options.socketPath, undefined, startDeadlineSignal(options.startSignal));

  let sweeper: { close(): Promise<void> } | undefined;
  let searchSweeper: { close(): Promise<void> } | undefined;
  let terminalSweeper: { close(): Promise<void> } | undefined;
  let poll: { close(): void } | undefined;
  let startupRelease: Promise<void> = Promise.resolve();
  const stop = async (): Promise<void> => {
    await searchSweeper?.close();
    await terminalSweeper?.close();
    await sweeper?.close();
    closeController.abort();
    await startupRelease;
    poll?.close();
    const closed = closeServer(server);
    server.closeAllConnections();
    await closed;
  };

  try {
    server.on('error', (error) => {
      if (onFatal !== undefined) onFatal(asError(error));
      else onError(error);
    });
    sweeper = startApprovalSweeper({
      store: options.store,
      clock: options.clock,
      timers,
      intervalMs: options.sweepIntervalMs ?? SWEEP_INTERVAL_MS,
      releaseStopped: options.releaseStopped,
      onError: report,
    });
    terminalSweeper = startTerminalSweeper({
      store: options.store,
      timers,
      intervalMs: options.sweepIntervalMs ?? SWEEP_INTERVAL_MS,
      ...(options.cancelUpstream === undefined ? {} : { cancelUpstream: options.cancelUpstream }),
      releaseStopped: options.releaseStopped,
      onError: report,
    });
    searchSweeper = startSearchSweeper({
      store: options.store,
      timers,
      intervalMs: options.sweepIntervalMs ?? SWEEP_INTERVAL_MS,
      batchSize: SEARCH_INDEX_BATCH_RUNS,
      redactor: options.redactor,
      onError: report,
    });
    startupRelease = releaseStoppedRunsAtStartup({
      store: options.store,
      releaseStopped: options.releaseStopped,
      signal: closeController.signal,
      onError: report,
    });
    poll = startDataVersionPoll({
      store: options.store,
      notifier: options.notifier,
      timers,
      intervalMs: options.dataVersionPollMs ?? 1000,
      onError: report,
    });
  } catch (error) {
    await stop();
    throw error;
  }

  let closing: Promise<void> | undefined;

  return {
    socketPath: options.socketPath,
    beginDraining: () => {
      draining = true;
    },
    close: () => {
      closing ??= stop();
      return closing;
    },
  };
};
