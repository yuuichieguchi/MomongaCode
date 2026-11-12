import http from 'node:http';
import path from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { SWEEP_INTERVAL_MS, encodeSse, hostPaths, listenUnix, startDeadlineSignal, systemRandom, personCapabilityOf } from '@momonga/foundation';
import { createMarkerOwners } from '@momonga/tools';
import type { MarkerOwners } from '@momonga/tools';
import type { PolicyVerification } from '../process/folder-verification.ts';
import type { GatewayStanding } from '../process/supervised-gateway.ts';
import type { Clock, FileSystem, Redactor, RolePort, KernelLockMechanism } from '@momonga/foundation';
import { DAEMON_CURRENT_EVENT } from '@momonga/protocol';
import type { Capabilities, CostBreakdownView, DaemonCurrentFrame, GatewayCostReportView, RunTraceView } from '@momonga/protocol';
import { isFatalStoreError } from '@momonga/store';
import type { RuntimeStore, Session } from '@momonga/store';
import type { PermissionRule } from '@momonga/config';
import { asError } from '../process/as-error.ts';
import type { SandboxKind } from '../process/sandbox-kind.ts';
import type { EvidenceRun } from '../memory/evidence.ts';
import type { SkillFileSystem } from '../memory/skill-promotion.ts';
import type { AgentCatalogPort, SkillsPort, UserInputPort } from '../ports.ts';
import { createRunApp } from './app.ts';
import type { ModelListing, RunLimitDefaults, SessionCreateSettings } from './app.ts';
import type { DelegationPort } from './delegation.ts';
import type { McpAdminPort } from './input-routes.ts';
import type { RunNotifier } from './notifier.ts';
import { startDataVersionPoll } from './data-version-poll.ts';
import { SEARCH_INDEX_BATCH_RUNS, startSearchSweeper } from './search-sweeper.ts';
import { releaseStoppedRunsAtStartup, startApprovalSweeper } from './sweeper.ts';
import { startTerminalSweeper } from './terminal-sweeper.ts';
import { systemTimers } from './timers.ts';
import type { ServiceTimers } from './timers.ts';
import type { ReportRouteDeps } from './report-routes.ts';

export { SWEEP_INTERVAL_MS };

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TWO_MIB = 2 * 1024 * 1024;

export type RunServiceOptions = {
  startSignal?: AbortSignal;
  markerOwners?: MarkerOwners;
  store: RuntimeStore;
  clock: Clock;
  redactor: Redactor;
  home: string;
  lock: KernelLockMechanism;
  version: string;
  socketPath: string;
  pid: number;
  startedAt: string;
  sandboxKind: (signal: AbortSignal) => Promise<SandboxKind>;
  protectedRootAreas: readonly string[];
  notifier: RunNotifier;
  modelListing: (signal: AbortSignal) => Promise<ModelListing>;
  delegation?: DelegationPort;
  modelCapabilities: (model: string, signal: AbortSignal) => Promise<Capabilities>;
  sessionCreateSettings: (cwd: string, signal: AbortSignal) => Promise<SessionCreateSettings>;
  sessionReadSettings: (cwd: string, signal: AbortSignal) => Promise<SessionCreateSettings>;
  skills: SkillsPort;
  agents: AgentCatalogPort;
  permissionRules: (session: Session, signal: AbortSignal) => Promise<readonly PermissionRule[]>;
  policyVerification: PolicyVerification;
  gatewayStanding: (signal: AbortSignal) => Promise<GatewayStanding>;
  userInput: UserInputPort;
  evidenceRun: (project: string) => EvidenceRun;
  skillFiles: SkillFileSystem;
  platform: NodeJS.Platform;
  defaults: { runTimeoutMs?: number; limits: RunLimitDefaults };
  timers?: ServiceTimers;
  keepAliveMs?: number;
  sweepIntervalMs?: number;
  dataVersionPollMs?: number;
  maxBodyBytes?: number;
  cancelUpstream?: (runId: string, signal: AbortSignal) => Promise<void>;
  releaseStopped(runId: string, signal: AbortSignal): Promise<void>;
  runTrace: (runId: string, signal: AbortSignal) => Promise<RunTraceView | undefined>;
  runCost: (runs: readonly { runId: string; sessionId: string }[], signal: AbortSignal, includeRunless: boolean) => Promise<{ report: GatewayCostReportView; text: string }>;
  runCostBreakdown: (runs: readonly { runId: string; sessionId: string }[], signal: AbortSignal, includeRunless: boolean) => Promise<{ breakdown: CostBreakdownView; text: string }>;
  reportCost: ReportRouteDeps['reportCost'];
  runTraceContent: ReportRouteDeps['runTraceContent'];
  recomputeFacts: ReportRouteDeps['recomputeFacts'];
  mcp: McpAdminPort;
  role: RolePort;
  work: { steps(): number; jobs(): number };
  ignorableMarkerDirectories: (signal: AbortSignal) => Promise<readonly string[]>;
  files: FileSystem;
  onRequestEnd?: () => void;
  onError?: (error: unknown) => void;
  onFatal?: (error: Error) => void;
};

export type RunService = {
  socketPath: string;
  beginDraining(): void;
  applyRole(): void;
  openRequests(): number;
  stopListening(): void;
  retire(current: DaemonCurrentFrame | undefined): Promise<void>;
  close(): Promise<void>;
};

const STREAM_REQUEST = /^\/v1\/(?:runs|sessions)\/[^/?]+\/events(?:\?|$)/;

const isStreamRequest = (request: http.IncomingMessage): boolean => (request.method === 'GET' || request.method === 'HEAD') && STREAM_REQUEST.test(request.url ?? '');

const frameOf = (current: DaemonCurrentFrame): Uint8Array =>
  new TextEncoder().encode(encodeSse({ event: DAEMON_CURRENT_EVENT, data: JSON.stringify({ generation: current.generation, version: current.version }) }));

const reportToStderr = (error: unknown): void => {
  console.error(error);
};

const assertInsideMomongaHome = async (home: string, socketPath: string, signal: AbortSignal): Promise<void> => {
  const paths = hostPaths(signal);
  const canonicalHome = await paths.canonicalPath(home);
  const socketDirectory = await paths.canonicalPath(path.dirname(socketPath));
  const allowed = path.join(canonicalHome, '.momonga');
  if (!(await paths.comparableContains(allowed, socketDirectory))) {
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
  const startSignal = startDeadlineSignal(options.startSignal);
  await assertInsideMomongaHome(options.home, options.socketPath, startSignal);

  const timers = options.timers ?? systemTimers;
  const onError = options.onError ?? reportToStderr;
  const { onFatal } = options;
  const report = (error: unknown): void => {
    if (onFatal !== undefined && isFatalStoreError(error)) onFatal(asError(error));
    else onError(error);
  };
  const closeController = new AbortController();
  const retireController = new AbortController();
  let retireFrame: Uint8Array | undefined;
  let draining = false;
  const runTimeoutMs = options.defaults.runTimeoutMs ?? SIX_HOURS_MS;
  const personCapability = await personCapabilityOf({ files: options.files, random: systemRandom, lock: options.lock }, options.home);
  const app = createRunApp({
    store: options.store,
    clock: options.clock,
    home: options.home,
    personCapability,
    version: options.version,
    modelListing: options.modelListing,
    ...(options.delegation === undefined ? {} : { delegation: options.delegation }),
    modelCapabilities: options.modelCapabilities,
    sessionCreateSettings: options.sessionCreateSettings,
    sessionReadSettings: options.sessionReadSettings,
    skills: options.skills,
    agents: options.agents,
    permissionRules: options.permissionRules,
    policyVerification: options.policyVerification,
    gatewayStanding: options.gatewayStanding,
    userInput: options.userInput,
    evidenceRun: options.evidenceRun,
    skillFiles: options.skillFiles,
    platform: options.platform,
    isDraining: () => draining,
    beginDraining: () => {
      draining = true;
    },
    role: () => options.role.current(),
    work: options.work,
    health: { pid: options.pid, startedAt: options.startedAt, sandbox: options.sandboxKind },
    protectedRootAreas: options.protectedRootAreas,
    defaults: { runTimeoutMs, limits: options.defaults.limits },
    notifier: options.notifier,
    timers,
    keepAliveMs: options.keepAliveMs ?? 15_000,
    maxBodyBytes: options.maxBodyBytes ?? TWO_MIB,
    closeSignal: closeController.signal,
    retireSignal: retireController.signal,
    retireFrame: () => retireFrame,
    runTrace: options.runTrace,
    runCost: options.runCost,
    runCostBreakdown: options.runCostBreakdown,
    reportCost: options.reportCost,
    runTraceContent: options.runTraceContent,
    recomputeFacts: options.recomputeFacts,
    mcp: options.mcp,
    markerOwners: options.markerOwners ?? createMarkerOwners(),
    ignorableMarkerDirectories: options.ignorableMarkerDirectories,
    files: options.files,
    onError: report,
  });
  const listener = getRequestListener((request, env) => app.fetch(request, env));
  let openRequests = 0;
  const openStreams = new Set<http.ServerResponse>();
  let streamsEnded: (() => void) | undefined;
  const server = http.createServer((request, response) => {
    if (options.role.current() === 'retiring') response.setHeader('connection', 'close');
    if (isStreamRequest(request)) {
      openStreams.add(response);
      response.once('close', () => {
        openStreams.delete(response);
        if (openStreams.size === 0) streamsEnded?.();
      });
    } else {
      openRequests += 1;
      const bound = timers.setTimeout(() => request.destroy(new Error(`the request outlasted the run deadline of ${runTimeoutMs} ms`)), runTimeoutMs);
      response.once('close', () => {
        timers.clearTimeout(bound);
        openRequests -= 1;
        options.onRequestEnd?.();
      });
    }
    void listener(request, response);
  });
  await listenUnix(server, options.socketPath, { mechanism: options.lock }, startSignal);

  type Sweepers = { approval: { close(): Promise<void> }; terminal: { close(): Promise<void> }; search: { close(): Promise<void> } };
  let sweepers: Sweepers | undefined;
  let sweepersClosing: Promise<void> = Promise.resolve();
  let poll: { close(): void } | undefined;
  let startupRelease: Promise<void> = Promise.resolve();
  let startupReleased = false;

  const closeSweepers = (): Promise<void> => {
    const running = sweepers;
    sweepers = undefined;
    if (running === undefined) return sweepersClosing;
    sweepersClosing = sweepersClosing.then(async () => {
      await running.search.close();
      await running.terminal.close();
      await running.approval.close();
    });
    return sweepersClosing;
  };

  const startSweepers = (): Sweepers => ({
    approval: startApprovalSweeper({
      store: options.store,
      clock: options.clock,
      timers,
      intervalMs: options.sweepIntervalMs ?? SWEEP_INTERVAL_MS,
      releaseStopped: options.releaseStopped,
      onError: report,
    }),
    terminal: startTerminalSweeper({
      store: options.store,
      timers,
      intervalMs: options.sweepIntervalMs ?? SWEEP_INTERVAL_MS,
      ...(options.cancelUpstream === undefined ? {} : { cancelUpstream: options.cancelUpstream }),
      releaseStopped: options.releaseStopped,
      onError: report,
    }),
    search: startSearchSweeper({
      store: options.store,
      timers,
      intervalMs: options.sweepIntervalMs ?? SWEEP_INTERVAL_MS,
      batchSize: SEARCH_INDEX_BATCH_RUNS,
      redactor: options.redactor,
      onError: report,
    }),
  });

  const applyRole = (): void => {
    if (closeController.signal.aborted) return;
    if (options.role.current() !== 'serving') {
      void closeSweepers().catch(report);
      return;
    }
    sweepers ??= startSweepers();
    if (startupReleased) return;
    startupReleased = true;
    startupRelease = releaseStoppedRunsAtStartup({
      store: options.store,
      releaseStopped: options.releaseStopped,
      signal: closeController.signal,
      onError: report,
    });
  };

  const stop = async (): Promise<void> => {
    await closeSweepers();
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
    applyRole();
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
    applyRole,
    openRequests: () => openRequests,
    stopListening: () => {
      if (server.listening) server.close();
      server.closeIdleConnections();
    },
    retire: (current) => {
      closing ??= (async () => {
        retireFrame = current === undefined ? undefined : frameOf(current);
        const ended = new Promise<void>((resolve) => {
          streamsEnded = resolve;
        });
        retireController.abort();
        if (openStreams.size > 0) await ended;
        await stop();
      })();
      return closing;
    },
    close: () => {
      closing ??= stop();
      return closing;
    },
  };
};
