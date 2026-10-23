import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { listenUnix } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import type { RuntimeStore } from '@momonga/store';
import { createRunApp } from './app.ts';
import type { RunLimitDefaults, SessionSettings } from './app.ts';
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
  notifier: RunNotifier;
  credentialEnvNames: () => readonly string[];
  modelAliases: () => Promise<readonly string[]>;
  settingsFor: (cwd: string) => Promise<SessionSettings>;
  defaults: { modelAlias: string; runTimeoutMs?: number; limits: RunLimitDefaults };
  timers?: ServiceTimers;
  keepAliveMs?: number;
  sweepIntervalMs?: number;
  dataVersionPollMs?: number;
  maxBodyBytes?: number;
  onError?: (error: unknown) => void;
};

export type RunService = { socketPath: string; close(): Promise<void> };

const reportToStderr = (error: unknown): void => {
  console.error(error);
};

const assertInsideMomongaHome = async (home: string, socketPath: string): Promise<void> => {
  const realHome = await fs.promises.realpath(home);
  const realParent = await fs.promises.realpath(path.dirname(socketPath));
  const allowed = path.join(realHome, '.momonga');
  if (realParent !== allowed && !realParent.startsWith(`${allowed}${path.sep}`)) {
    throw new Error(`the run socket must live under ${allowed}, but ${socketPath} resolves to ${realParent}`);
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
  await assertInsideMomongaHome(options.home, options.socketPath);

  const timers = options.timers ?? systemTimers;
  const onError = options.onError ?? reportToStderr;
  const closeController = new AbortController();
  const app = createRunApp({
    store: options.store,
    clock: options.clock,
    version: options.version,
    credentialEnvNames: options.credentialEnvNames,
    modelAliases: options.modelAliases,
    settingsFor: options.settingsFor,
    defaults: { modelAlias: options.defaults.modelAlias, runTimeoutMs: options.defaults.runTimeoutMs ?? SIX_HOURS_MS, limits: options.defaults.limits },
    notifier: options.notifier,
    timers,
    keepAliveMs: options.keepAliveMs ?? 15_000,
    maxBodyBytes: options.maxBodyBytes ?? TWO_MIB,
    closeSignal: closeController.signal,
    onError,
  });

  const server = http.createServer(getRequestListener((request, env) => app.fetch(request, env)));
  await listenUnix(server, options.socketPath);

  const sweeper = startApprovalSweeper({
    store: options.store,
    clock: options.clock,
    timers,
    intervalMs: options.sweepIntervalMs ?? 1000,
    onError,
  });

  const poll = startDataVersionPoll({
    store: options.store,
    notifier: options.notifier,
    timers,
    intervalMs: options.dataVersionPollMs ?? 1000,
    onError,
  });
  let closing: Promise<void> | undefined;

  return {
    socketPath: options.socketPath,
    close: () => {
      closing ??= (async () => {
        sweeper.close();
        poll.close();
        closeController.abort();
        const closed = closeServer(server);
        server.closeAllConnections();
        await closed;
      })();
      return closing;
    },
  };
};
