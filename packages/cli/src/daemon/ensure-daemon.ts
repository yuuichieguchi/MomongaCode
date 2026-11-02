import { EXIT_ALREADY_RUNNING, ENTRY_HARD_EXIT_MARGIN_MS, RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS, inspectProcessLock, supervisorMaxCloseMs } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import type { SupervisorHealth } from '@momonga/protocol';
import { createSupervisorClient } from '../client/supervisor-client.ts';
import type { SupervisorClient } from '../client/supervisor-client.ts';
import { DAEMON_POLL_INTERVAL_MS } from '../constants.ts';
import { pollUntil } from '../poll.ts';
import type { CliPorts, DetachedExit } from '../ports.ts';
import { compareVersions, tryParseVersion } from '../update/version.ts';
import { INTERNAL_COMMANDS, selfInvocation } from './launcher.ts';

export class DaemonStartError extends Error {
  readonly logFile: string;

  constructor(message: string, logFile: string) {
    super(`${message}; see ${logFile}`);
    this.name = 'DaemonStartError';
    this.logFile = logFile;
  }
}

export type DaemonPorts = Pick<CliPorts, 'version' | 'env' | 'home' | 'clock' | 'self' | 'spawnDetached'>;

const UNREACHABLE_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOENT']);

const errnoCodeOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
};

export const probeSupervisor = async (client: SupervisorClient): Promise<SupervisorHealth | undefined> => {
  try {
    return await client.health();
  } catch (error) {
    const code = errnoCodeOf(error);
    if (code !== undefined && UNREACHABLE_CODES.has(code)) return undefined;
    throw error;
  }
};

export type DaemonBounds = { readyMs: number; stopMs: number };

export const daemonReadyBoundMs = async (): Promise<number> => {
  const { STARTUP_TIMEOUT_MS, ORPHAN_REAP_GRACE_MS } = await import('@momonga/supervisor');
  return ORPHAN_REAP_GRACE_MS + STARTUP_TIMEOUT_MS;
};

export const daemonStopBoundMs = (): number => supervisorMaxCloseMs(RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS) + ENTRY_HARD_EXIT_MARGIN_MS;

export const defaultDaemonBounds = async (): Promise<DaemonBounds> => ({ readyMs: await daemonReadyBoundMs(), stopMs: daemonStopBoundMs() });

const superviseFlags = (ports: DaemonPorts): string[] => [`--home=${ports.home}`, '--log-target=file'];

const unready = (health: SupervisorHealth): string | undefined => {
  if (health.phase !== 'running') return `supervisor phase ${health.phase}`;
  const waiting = health.children.filter((child) => child.state !== 'ready');
  if (waiting.length === 0) return undefined;
  return waiting.map((child) => `${child.role} ${child.state}`).join(', ');
};

const heldFailure = (health: SupervisorHealth): string | undefined => {
  const held = health.children.find((child) => child.state === 'held-config');
  return held === undefined ? undefined : `${held.role} is held by its configuration: ${held.heldReason ?? 'no reason reported'}`;
};

const exitDescription = (exit: DetachedExit): string => `code ${exit.code}, signal ${exit.signal}`;

export const waitForSupervisorGone = async (ports: Pick<DaemonPorts, 'clock'>, paths: MomongaPaths, stopMs: number, signal?: AbortSignal): Promise<void> => {
  await pollUntil(
    ports.clock,
    async () => ((await inspectProcessLock(paths.locks.supervisor)).state === 'free' ? true : undefined),
    { boundMs: stopMs, intervalMs: DAEMON_POLL_INTERVAL_MS, description: 'the previous supervisor to release its lock', ...(signal === undefined ? {} : { signal }) },
  );
};

export const stopDaemon = async (ports: DaemonPorts, paths: MomongaPaths, bounds?: DaemonBounds): Promise<{ stopped: boolean }> => {
  const client = createSupervisorClient({ socketPath: paths.sockets.supervisor });
  try {
    const health = await probeSupervisor(client);
    if (health === undefined) return { stopped: false };
    if (health.phase !== 'draining') await client.shutdown();
    await waitForSupervisorGone(ports, paths, (bounds ?? (await defaultDaemonBounds())).stopMs);
    return { stopped: true };
  } finally {
    await client.close();
  }
};

type SpawnOutcome = { exit: DetachedExit } | { error: unknown };

type SpawnedSupervisor = { outcome(): SpawnOutcome | undefined };

const awaitReady = async (ports: DaemonPorts, paths: MomongaPaths, client: SupervisorClient, readyMs: number, signal?: AbortSignal, spawned?: SpawnedSupervisor): Promise<SupervisorHealth> =>
  pollUntil(
    ports.clock,
    async () => {
      const health = await probeSupervisor(client);
      if (health !== undefined) {
        if (spawned !== undefined && health.version !== ports.version) {
          throw new DaemonStartError(`the daemon (pid ${health.pid}) runs version ${health.version}, not ${ports.version}; run \`momonga daemon stop\``, paths.logFiles.supervisor);
        }
        const held = heldFailure(health);
        if (held !== undefined) throw new DaemonStartError(held, paths.logFiles.supervisor);
        if (unready(health) === undefined) return health;
      }
      const outcome = spawned?.outcome();
      if (outcome !== undefined && 'error' in outcome) throw outcome.error;
      if (outcome !== undefined && outcome.exit.code !== EXIT_ALREADY_RUNNING) {
        throw new DaemonStartError(`the supervisor exited (${exitDescription(outcome.exit)}) before it was ready`, paths.logFiles.supervisor);
      }
      return undefined;
    },
    { boundMs: readyMs, intervalMs: DAEMON_POLL_INTERVAL_MS, description: 'the daemon to become ready', ...(signal === undefined ? {} : { signal }) },
  );

const startDaemon = async (ports: DaemonPorts, paths: MomongaPaths, client: SupervisorClient, readyMs: number, signal?: AbortSignal): Promise<SupervisorHealth> => {
  const invocation = selfInvocation(ports.self, INTERNAL_COMMANDS.supervise, superviseFlags(ports));
  const child = ports.spawnDetached({ command: invocation.command, args: invocation.args, env: ports.env, cwd: ports.home });
  let outcome: SpawnOutcome | undefined;
  void child.exit.then(
    (exit) => {
      outcome = { exit };
    },
    (error: unknown) => {
      outcome = { error };
    },
  );
  return awaitReady(ports, paths, client, readyMs, signal, { outcome: () => outcome });
};

export type DaemonReplacement = 'never' | 'when-idle' | 'always';

export type EnsureDaemonOptions = { bounds?: DaemonBounds; replacement?: DaemonReplacement; signal?: AbortSignal };

const isStrictlyNewerThan = (clientVersion: string, daemonVersion: string): boolean => {
  const client = tryParseVersion(clientVersion);
  const daemon = tryParseVersion(daemonVersion);
  return client !== undefined && daemon !== undefined && compareVersions(client, daemon) === 1;
};

const replaceOlder = async (ports: DaemonPorts, client: SupervisorClient, current: SupervisorHealth, replacement: DaemonReplacement): Promise<boolean> => {
  if (replacement === 'never' || !isStrictlyNewerThan(ports.version, current.version)) return false;
  if (replacement === 'always') {
    await client.shutdown();
    return true;
  }
  return (await client.shutdownIfIdle()).accepted;
};

export const ensureDaemon = async (ports: DaemonPorts, paths: MomongaPaths, options: EnsureDaemonOptions = {}): Promise<SupervisorHealth> => {
  const { signal } = options;
  signal?.throwIfAborted();
  const { readyMs, stopMs } = options.bounds ?? (await defaultDaemonBounds());
  const client = createSupervisorClient({ socketPath: paths.sockets.supervisor });
  try {
    const current = await probeSupervisor(client);
    if (current === undefined) return await startDaemon(ports, paths, client, readyMs, signal);
    if (current.phase === 'draining') {
      await waitForSupervisorGone(ports, paths, stopMs, signal);
      return await startDaemon(ports, paths, client, readyMs, signal);
    }
    if (await replaceOlder(ports, client, current, options.replacement ?? 'never')) {
      await waitForSupervisorGone(ports, paths, stopMs, signal);
      return await startDaemon(ports, paths, client, readyMs, signal);
    }
    return await awaitReady(ports, paths, client, readyMs, signal);
  } finally {
    await client.close();
  }
};
