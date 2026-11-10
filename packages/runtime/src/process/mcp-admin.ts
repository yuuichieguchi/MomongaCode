import { loadMcpServers } from '@momonga/config';
import type { McpServerEntry, SettingsUse, UserLayer } from '@momonga/config';
import { AUTHORIZATION_WAIT_MS, CredentialStoreError, canonicalJson, sha256Hex } from '@momonga/foundation';
import type { Clock, JsonLogger } from '@momonga/foundation';
import { McpAuthorizationError } from '@momonga/mcp';
import type { McpAuthorizingPool, McpMarkerOptions, McpPoolOptions, McpRemotePorts } from '@momonga/mcp';
import type { McpAuthorizationView, McpServerView } from '@momonga/protocol';
import type { RuntimeStore, Session } from '@momonga/store';
import type { ToolEnv } from '../ports.ts';
import { invalidRequest, notFound } from '../service/errors.ts';
import type { ServiceTimers } from '../service/timers.ts';
import { asError } from './as-error.ts';
import { MCP_CLOSE_GRACE_MS, POOL_IDLE_CLOSE_MS } from './constants.ts';
import type { SettingsComposition } from './settings-port.ts';

export type McpAdmin = {
  servers(sessionId: string, signal: AbortSignal): Promise<McpServerView[]>;
  startAuthorization(sessionId: string, name: string): Promise<McpAuthorizationView>;
  authorization(sessionId: string, name: string): McpAuthorizationView | undefined;
  cancelAuthorization(sessionId: string, name: string): boolean;
  close(): Promise<void>;
};

export type McpAdminOptions = {
  home: string;
  store: Pick<RuntimeStore, 'getSession'>;
  clock: Clock;
  timers: ServiceTimers;
  logger: JsonLogger;
  report(error: unknown): void;
  settings: Pick<SettingsComposition, 'envFor' | 'admitUserSnapshot' | 'keptLayers' | 'trustOracle'>;
  remote: McpRemotePorts;
  createPool(options: McpPoolOptions): McpAuthorizingPool;
  markers?: McpMarkerOptions;
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
  session: Session,
  env: ToolEnv,
  user: UserLayer,
  use: SettingsUse,
): ReturnType<typeof loadMcpServers> =>
  loadMcpServers({
    home: options.home,
    projectDir: session.cwd,
    trust: options.settings.trustOracle,
    env,
    user,
    kept: options.settings.keptLayers(use),
    sessionServers: session.mcpServers,
  });

const failureOf = (server: string, error: unknown): { code: string; message: string } => {
  if (error instanceof McpAuthorizationError) return { code: error.failure, message: error.message };
  if (error instanceof CredentialStoreError) return { code: error.code, message: error.message };
  return { code: 'error', message: `the authorization of MCP server "${server}" failed: ${asError(error).message}` };
};

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

  const serverOf = async (session: Session, name: string): Promise<McpServerEntry> => {
    const loaded = await loadSessionMcpServers(options, session, options.settings.envFor(session), options.settings.admitUserSnapshot().user, 'admit');
    const entry = loaded.enabled.find((candidate) => candidate.name === name);
    if (entry === undefined) throw notFound(`session ${session.id} has no enabled MCP server named ${name}`);
    return entry;
  };

  const poolFor = (servers: McpServerEntry[], session: Session, remote: McpRemotePorts): McpAuthorizingPool =>
    options.createPool({
      servers,
      projectDir: session.cwd,
      baseEnv: { ...options.settings.envFor(session) },
      clock,
      timers: options.timers,
      remote,
      closeGraceMs: MCP_CLOSE_GRACE_MS,
      ...(options.markers === undefined ? {} : { markers: options.markers }),
    });

  const keyOf = (sessionId: string, name: string): string => `${sessionId}/${name}`;

  const closeProbePool = (key: string, entry: ProbePool): void => {
    if (probePools.get(key) !== entry) return;
    probePools.delete(key);
    const settled = entry.pool.close().catch(report);
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
    if (entry.users === 0) entry.idle = options.timers.setTimeout(() => closeProbePool(key, entry), POOL_IDLE_CLOSE_MS);
  };

  const servers: McpAdmin['servers'] = async (sessionId, signal) => {
    const session = sessionOf(sessionId);
    const loaded = await loadSessionMcpServers(options, session, options.settings.envFor(session), options.settings.admitUserSnapshot().user, 'admit');
    const key = sha256Hex(canonicalJson({ session: session.id, cwd: session.cwd, servers: loaded.enabled }));
    const held = acquireProbePool(key, () => poolFor(loaded.enabled, session, options.remote));
    const { pool } = held;
    try {
      const views: McpServerView[] = [];
      for (const entry of loaded.enabled) {
        signal.throwIfAborted();
        const probe = await pool.authState(entry.name, signal);
        const attempt = attempts.get(keyOf(sessionId, entry.name));
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

  const startAuthorization: McpAdmin['startAuthorization'] = async (sessionId, name) => {
    const session = sessionOf(sessionId);
    const entry = await serverOf(session, name);
    if (!('url' in entry.config)) throw invalidRequest(`MCP server ${name} is a stdio server and has no authorization`, 'name');
    const key = keyOf(sessionId, name);
    const running = attempts.get(key);
    if (running?.view.status === 'awaiting_user') return { ...running.view };

    const startedAt = clock.now();
    const view: McpAuthorizationView = { server: name, status: 'awaiting_user', startedAt, expiresAt: startedAt + AUTHORIZATION_WAIT_MS };
    const controller = new AbortController();
    let surface: () => void = () => undefined;
    const surfaced = new Promise<void>((resolve) => {
      surface = resolve;
    });
    const pool = poolFor([entry], session, {
      ...options.remote,
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
        await pool.close();
      }
    })();
    settled.catch(report);
    attempts.set(key, { view, controller, surfaced, settled });
    await surfaced;
    return { ...view };
  };

  return {
    servers,
    startAuthorization,
    authorization: (sessionId, name) => {
      sessionOf(sessionId);
      const attempt = attempts.get(keyOf(sessionId, name));
      return attempt === undefined ? undefined : { ...attempt.view };
    },
    cancelAuthorization: (sessionId, name) => {
      sessionOf(sessionId);
      const attempt = attempts.get(keyOf(sessionId, name));
      if (attempt === undefined || attempt.view.status !== 'awaiting_user') return false;
      attempt.controller.abort(new Error('authorization was cancelled by the client'));
      return true;
    },
    close: async () => {
      for (const attempt of attempts.values()) attempt.controller.abort(new Error('the runtime is shutting down'));
      for (const [key, entry] of [...probePools]) {
        if (entry.idle !== undefined) options.timers.clearTimeout(entry.idle);
        closeProbePool(key, entry);
      }
      await Promise.all([...attempts.values()].map((attempt) => attempt.settled));
      await Promise.all(closing);
    },
  };
};
