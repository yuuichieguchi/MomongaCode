import http from 'node:http';
import path from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { canonicalPath, comparableContains, listenUnix } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import type { RunTraceView } from '@momonga/protocol';
import { isFatalStoreError } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { asError } from '../process/as-error.ts';
import type { SandboxKind } from '../process/sandbox-kind.ts';
import type { SkillsPort } from '../ports.ts';
import { createRunApp } from './app.ts';
import type { RunLimitDefaults, SessionCreateSettings } from './app.ts';
import type { McpAdminPort } from './input-routes.ts';
import type { RunNotifier } from './notifier.ts';
import { startDataVersionPoll } from './data-version-poll.ts';
import { startApprovalSweeper } from './sweeper.ts';
import { systemTimers } from './timers.ts';
import type { ServiceTimers } from './timers.ts';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TWO_MIB = 2 * 1024 * 1024;

export type RunServiceOptions = {
  store: RuntimeStore;
  clock: Clock;
  home: string;
  version: string;
  socketPath: string;
  pid: number;
  startedAt: string;
  sandboxKind: SandboxKind;
  protectedRootAreas: readonly string[];
  notifier: RunNotifier;
  modelAliases: () => Promise<readonly string[]>;
  sessionCreateSettings: (cwd: string) => Promise<SessionCreateSettings>;
  skills: SkillsPort;
  defaults: { modelAlias: string; runTimeoutMs?: number; limits: RunLimitDefaults };
  timers?: ServiceTimers;
  keepAliveMs?: number;
  sweepIntervalMs?: number;
  dataVersionPollMs?: number;
  maxBodyBytes?: number;
  cancelUpstream?: (runId: string) => Promise<void>;
  runTrace: (runId: string) => Promise<RunTraceView | undefined>;
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
    version: options.version,
    modelAliases: options.modelAliases,
    sessionCreateSettings: options.sessionCreateSettings,
    skills: options.skills,
    isDraining: () => draining,
    health: { pid: options.pid, startedAt: options.startedAt, sandbox: options.sandboxKind },
    protectedRootAreas: options.protectedRootAreas,
    defaults: { modelAlias: options.defaults.modelAlias, runTimeoutMs: options.defaults.runTimeoutMs ?? SIX_HOURS_MS, limits: options.defaults.limits },
    notifier: options.notifier,
    timers,
    keepAliveMs: options.keepAliveMs ?? 15_000,
    maxBodyBytes: options.maxBodyBytes ?? TWO_MIB,
    closeSignal: closeController.signal,
    runTrace: options.runTrace,
    mcp: options.mcp,
    ...(options.cancelUpstream === undefined ? {} : { cancelUpstream: options.cancelUpstream }),
    onError: report,
  });

  const server = http.createServer(getRequestListener((request, env) => app.fetch(request, env)));
  await listenUnix(server, options.socketPath);

  let sweeper: { close(): void } | undefined;
  let poll: { close(): void } | undefined;
  const stop = async (): Promise<void> => {
    sweeper?.close();
    poll?.close();
    closeController.abort();
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
      intervalMs: options.sweepIntervalMs ?? 1000,
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
