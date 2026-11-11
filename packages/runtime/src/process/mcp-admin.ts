import { loadMcpServers } from '@momonga/config';
import type { McpServerEntry, SettingsUse, UserLayer } from '@momonga/config';
import { AUTHORIZATION_WAIT_MS, CredentialStoreError, canonicalJson, nodeFileSystem, sha256Hex } from '@momonga/foundation';
import type { Clock, JsonLogger } from '@momonga/foundation';
import { McpAuthorizationError } from '@momonga/mcp';
import type { McpAuthorizingPool, McpMarkerOptions, McpPoolOptions, McpRemotePorts } from '@momonga/mcp';
import type { McpAuthorizationView, McpServerView } from '@momonga/protocol';
import type { RuntimeStore, Session } from '@momonga/store';
import type { ToolEnv } from '../ports.ts';
import { invalidRequest, notFound } from '../service/errors.ts';
import type { ServiceTimers } from '../service/timers.ts';
import { asError } from './as-error.ts';
import { POOL_IDLE_CLOSE_MS } from './constants.ts';
import type { NetworkOf } from './network-derivation.ts';
import type { SettingsComposition } from './settings-port.ts';

export type McpFolder = { cwd: string; env: Readonly<Record<string, string>> };

export type McpScope = Pick<Session, 'id' | 'cwd' | 'env' | 'mcpServers'>;

const folderScopeId = (cwd: string): string => `folder:${sha256Hex(cwd)}`;

const folderScope = (folder: McpFolder): McpScope => ({ id: folderScopeId(folder.cwd), cwd: folder.cwd, env: { ...folder.env }, mcpServers: {} });

export type McpAdmin = {
  servers(sessionId: string, signal: AbortSignal): Promise<McpServerView[]>;
  startAuthorization(sessionId: string, name: string, signal: AbortSignal): Promise<McpAuthorizationView>;
  authorization(sessionId: string, name: string): McpAuthorizationView | undefined;
  cancelAuthorization(sessionId: string, name: string): boolean;
  folderServers(folder: McpFolder, signal: AbortSignal): Promise<McpServerView[]>;
  startFolderAuthorization(folder: McpFolder, name: string, signal: AbortSignal): Promise<McpAuthorizationView>;
  folderAuthorization(cwd: string, name: string): McpAuthorizationView | undefined;
  cancelFolderAuthorization(cwd: string, name: string): boolean;
  pendingAuthorizations(): number;
  close(graceMs: number): Promise<void>;
};

export type McpAdminOptions = {
  home: string;
  store: Pick<RuntimeStore, 'getSession'>;
  clock: Clock;
  timers: ServiceTimers;
  logger: JsonLogger;
  report(error: unknown): void;
  settings: Pick<SettingsComposition, 'envFor' | 'admitUserSnapshot' | 'keptLayers' | 'trustOracle'>;
  remote: Omit<McpRemotePorts, 'network'>;
  network: NetworkOf;
  createPool(options: McpPoolOptions): McpAuthorizingPool;
  clientVersion: string;
  readCloseGraceMs(): number;
  readConnectTimeoutMs(): number | undefined;
  markers?: McpMarkerOptions;
  onAuthorizationEnded?: () => void;
};

type ProbePool = { pool: McpAuthorizingPool; users: number; idle?: unknown };

type Attempt = {
  view: McpAuthorizationView;
  controller: AbortController;
  surfaced: Promise<void>;
  settled: Promise<void>;
};

export const loadSessionMcpServers = (
  options: { home: string; settings: Pick<SettingsComposition, 'trustOracle' | 'keptLayers'> },
  session: Pick<Session, 'cwd' | 'mcpServers'>,
  env: ToolEnv,
  user: UserLayer,
  use: SettingsUse,
  signal: AbortSignal,
): ReturnType<typeof loadMcpServers> =>
  loadMcpServers({
    home: options.home,
    projectDir: session.cwd,
    trust: options.settings.trustOracle,
    env,
    signal,
    user,
    kept: options.settings.keptLayers(use),
    sessionServers: session.mcpServers,
  });

const failureOf = (server: string, error: unknown): { code: string; message: string } => {
  if (error instanceof McpAuthorizationError) return { code: error.failure, message: error.message };
  if (error instanceof CredentialStoreError) return { code: error.code, message: error.message };
  return { code: 'error', message: `the authorization of MCP server "${server}" failed: ${asError(error).message}` };
};

const connectTimeoutOf = (connectTimeoutMs: number | undefined): { connectTimeoutMs?: number } => (connectTimeoutMs === undefined ? {} : { connectTimeoutMs });

export const createMcpAdmin = (options: McpAdminOptions): McpAdmin => {
  const { clock, report } = options;
  const attempts = new Map<string, Attempt>();
  const probePools = new Map<string, ProbePool>();
  const closing = new Set<Promise<void>>();

  const sessionOf = (sessionId: string): Session => {
    const session = options.store.getSession(sessionId);
    if (session === undefined) throw notFound(`session ${sessionId} does not exist`);
    return session;
  };

  const serverOf = async (scope: McpScope, name: string, signal: AbortSignal): Promise<McpServerEntry> => {
    const { user } = await options.settings.admitUserSnapshot(signal);
    const loaded = await loadSessionMcpServers(options, scope, await options.settings.envFor(scope, signal), user, 'admit', signal);
    const entry = loaded.enabled.find((candidate) => candidate.name === name);
    if (entry === undefined) throw notFound(`${scope.cwd} has no enabled MCP server named ${name}`);
    return entry;
  };

  const poolFor = (servers: McpServerEntry[], session: Pick<Session, 'cwd'>, env: ToolEnv, remote: McpRemotePorts): McpAuthorizingPool =>
    options.createPool({
      servers,
      projectDir: session.cwd,
      baseEnv: { ...env },
      files: nodeFileSystem,
      clock,
      clientVersion: options.clientVersion,
      timers: options.timers,
      remote,
      closeGraceMs: options.readCloseGraceMs,
      ...connectTimeoutOf(options.readConnectTimeoutMs()),
      ...(options.markers === undefined ? {} : { markers: options.markers }),
    });

  const keyOf = (scopeId: string, name: string): string => `${scopeId}/${name}`;

  const closeProbePool = (key: string, entry: ProbePool, graceMs: number): void => {
    if (probePools.get(key) !== entry) return;
    probePools.delete(key);
    const settled = entry.pool.close(graceMs).catch(report);
    const tracked = settled.finally(() => {
      closing.delete(tracked);
    });
    closing.add(tracked);
  };

  const acquireProbePool = (key: string, create: () => McpAuthorizingPool): ProbePool => {
    const existing = probePools.get(key);
    const entry = existing ?? { pool: create(), users: 0 };
    if (existing === undefined) probePools.set(key, entry);
    if (entry.idle !== undefined) {
      options.timers.clearTimeout(entry.idle);
      delete entry.idle;
    }
    entry.users += 1;
    return entry;
  };

  const releaseProbePool = (key: string, entry: ProbePool): void => {
    entry.users -= 1;
    if (entry.users === 0) entry.idle = options.timers.setTimeout(() => closeProbePool(key, entry, options.readCloseGraceMs()), POOL_IDLE_CLOSE_MS);
  };

  const serversOf = async (session: McpScope, signal: AbortSignal): Promise<McpServerView[]> => {
    const { user } = await options.settings.admitUserSnapshot(signal);
    const env = await options.settings.envFor(session, signal);
    const loaded = await loadSessionMcpServers(options, session, env, user, 'admit', signal);
    const network = await options.network(signal);
    const key = sha256Hex(canonicalJson({ session: session.id, cwd: session.cwd, servers: loaded.enabled, network: network.identity }));
    const held = acquireProbePool(key, () => poolFor(loaded.enabled, session, env, { ...options.remote, network: network.outbound }));
    const { pool } = held;
    try {
      const views: McpServerView[] = [];
      for (const entry of loaded.enabled) {
        signal.throwIfAborted();
        const probe = await pool.authState(entry.name, signal);
        const attempt = attempts.get(keyOf(session.id, entry.name));
        views.push({
          name: entry.name,
          scope: entry.scope,
          transport: 'url' in entry.config ? 'http' : 'stdio',
          ...('url' in entry.config ? { url: entry.config.url } : {}),
          auth: probe.state,
          ...(probe.detail === undefined ? {} : { detail: probe.detail }),
          ...(attempt === undefined ? {} : { authorization: { ...attempt.view } }),
        });
      }
      return views;
    } finally {
      releaseProbePool(key, held);
    }
  };

  const startAuthorizationOf = async (session: McpScope, name: string, signal: AbortSignal): Promise<McpAuthorizationView> => {
    const entry = await serverOf(session, name, signal);
    if (!('url' in entry.config)) throw invalidRequest(`MCP server ${name} is a stdio server and has no authorization`, 'name');
    const key = keyOf(session.id, name);
    const running = attempts.get(key);
    if (running?.view.status === 'awaiting_user') return { ...running.view };

    const startedAt = clock.now();
    const view: McpAuthorizationView = { server: name, status: 'awaiting_user', startedAt, expiresAt: startedAt + AUTHORIZATION_WAIT_MS };
    const controller = new AbortController();
    let surface: () => void = () => undefined;
    const surfaced = new Promise<void>((resolve) => {
      surface = resolve;
    });
    const network = await options.network(signal);
    const pool = poolFor([entry], session, await options.settings.envFor(session, signal), {
      ...options.remote,
      network: network.outbound,
      openAuthorizationUrl: (url) => {
        view.url = url.href;
        surface();
        return Promise.resolve();
      },
    });
    const settled = (async (): Promise<void> => {
      try {
        await pool.authorize(name, controller.signal);
        view.status = 'completed';
      } catch (error) {
        view.status = 'failed';
        view.failure = failureOf(name, error);
      } finally {
        surface();
        try {
          await pool.close();
        } finally {
          options.onAuthorizationEnded?.();
        }
      }
    })();
    settled.catch(report);
    attempts.set(key, { view, controller, surfaced, settled });
    await surfaced;
    return { ...view };
  };

  const authorizationOf = (scopeId: string, name: string): McpAuthorizationView | undefined => {
    const attempt = attempts.get(keyOf(scopeId, name));
    return attempt === undefined ? undefined : { ...attempt.view };
  };

  const cancelAuthorizationOf = (scopeId: string, name: string): boolean => {
    const attempt = attempts.get(keyOf(scopeId, name));
    if (attempt === undefined || attempt.view.status !== 'awaiting_user') return false;
    attempt.controller.abort(new Error('authorization was cancelled by the client'));
    return true;
  };

  return {
    servers: async (sessionId, signal) => serversOf(sessionOf(sessionId), signal),
    startAuthorization: async (sessionId, name, signal) => startAuthorizationOf(sessionOf(sessionId), name, signal),
    authorization: (sessionId, name) => authorizationOf(sessionOf(sessionId).id, name),
    cancelAuthorization: (sessionId, name) => cancelAuthorizationOf(sessionOf(sessionId).id, name),
    folderServers: (folder, signal) => serversOf(folderScope(folder), signal),
    startFolderAuthorization: (folder, name, signal) => startAuthorizationOf(folderScope(folder), name, signal),
    folderAuthorization: (cwd, name) => authorizationOf(folderScopeId(cwd), name),
    cancelFolderAuthorization: (cwd, name) => cancelAuthorizationOf(folderScopeId(cwd), name),
    pendingAuthorizations: () => [...attempts.values()].filter((attempt) => attempt.view.status === 'awaiting_user').length,
    close: async (graceMs) => {
      for (const attempt of attempts.values()) attempt.controller.abort(new Error('the runtime is shutting down'));
      for (const [key, entry] of [...probePools]) {
        if (entry.idle !== undefined) options.timers.clearTimeout(entry.idle);
        closeProbePool(key, entry, graceMs);
      }
      await Promise.all([...attempts.values()].map((attempt) => attempt.settled));
      await Promise.all(closing);
    },
  };
};
