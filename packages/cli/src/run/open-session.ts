import { credentialEnvNames, loadUserSettings, stripCredentialEnv } from '@momonga/config';
import { currentSocketResolver } from '@momonga/foundation';
import type { MomongaPaths, SandboxNetworkSetting } from '@momonga/foundation';
import { TARGET_NOT_READY, messageOf, startModelOf } from '@momonga/protocol';
import type { Mandate, MomongaModelList, PermissionMode } from '@momonga/protocol';
import { createRuntimeClient } from '../client/runtime-client.ts';
import type { CreatedSession, RuntimeClient } from '../client/runtime-client.ts';
import type { SessionView } from '../client/views.ts';
import { ensureSessionDaemon } from '../daemon/ensure-daemon.ts';
import { endSessionWhenMovedAway, sessionSocketResolver } from '../daemon/generations.ts';
import type { CliPorts } from '../ports.ts';
import type { DaemonPorts, NewerListener } from '../daemon/ensure-daemon.ts';
import { reopenedSession } from './resolve-session.ts';
import type { HeadlessReopen } from './resolve-session.ts';
import { UsageError } from '../usage-error.ts';

export type SessionOptions = { permissionMode?: PermissionMode; bypassAllowed?: boolean; sandboxNetwork?: SandboxNetworkSetting; model?: string; signal?: AbortSignal };

export type RunBounds = { mandate?: Mandate; limits?: { maxCostUsd?: number } };

export const runBoundsOf = (bounds: RunBounds): RunBounds => ({ ...(bounds.mandate === undefined ? {} : { mandate: bounds.mandate }), ...(bounds.limits === undefined ? {} : { limits: bounds.limits }) });

export type ListedModels = Pick<MomongaModelList, 'data' | 'start'>;

export type Reopening = { reopen: HeadlessReopen; modelList(): Promise<ListedModels> } | { reopen?: undefined };

export type OpenSessionOptions = Omit<SessionOptions, 'signal'> & { signal: AbortSignal } & Reopening & { onNewer?: NewerListener };

export class NoModelConnected extends Error {
  readonly code = TARGET_NOT_READY;
  readonly reason: string;

  constructor() {
    const message = messageOf('noModelConnected', 'cli');
    super(message);
    this.name = 'NoModelConnected';
    this.reason = message;
  }
}

export type TypedSessionOptions = Pick<SessionOptions, 'permissionMode' | 'bypassAllowed' | 'model'>;

const BYPASS_MODE: PermissionMode = 'bypassPermissions';

export const reopenedAsTyped = async (client: Pick<RuntimeClient, 'listSessions' | 'updateSession'>, cwd: string, platform: NodeJS.Platform, reopen: HeadlessReopen, typed: TypedSessionOptions): Promise<SessionView> => {
  const stored = await reopenedSession(client, cwd, platform, reopen);
  const mode = typed.permissionMode ?? stored.permissionMode;
  if (mode === BYPASS_MODE && typed.bypassAllowed !== true) throw new UsageError(messageOf('storedBypassNeedsOptIn', 'cli', { id: stored.id }));
  if (mode === BYPASS_MODE && !stored.bypassAllowed) throw new UsageError(messageOf('bypassNotStarted', 'cli', { id: stored.id }));
  if (typed.model !== undefined) return client.updateSession(stored.id, { model: typed.model, ...(mode === stored.permissionMode ? {} : { permissionMode: mode }) });
  return mode === stored.permissionMode ? stored : client.updateSession(stored.id, { permissionMode: mode });
};

export type CliSession = {
  client: RuntimeClient;
  created: CreatedSession;
  close(): Promise<void>;
};

export const environmentSnapshot = async (ports: Pick<CliPorts, 'env' | 'home'>, signal: AbortSignal): Promise<Record<string, string>> => {
  const { settings } = await loadUserSettings({ env: process.env, home: ports.home, signal });
  const defined = Object.fromEntries(Object.entries(ports.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return stripCredentialEnv(defined, credentialEnvNames(settings.models), settings.credentials).env;
};

export const autoModeConfigured = async (ports: Pick<CliPorts, 'home'>, signal: AbortSignal): Promise<boolean> => {
  const { settings } = await loadUserSettings({ env: process.env, home: ports.home, signal });
  return settings.autoMode?.classifier !== undefined;
};

export const connectRuntime = (ports: Pick<CliPorts, 'clock' | 'personCapability'>, paths: MomongaPaths): RuntimeClient =>
  createRuntimeClient({ resolveSocket: currentSocketResolver(paths, 'runtime'), clock: ports.clock, personCapability: () => ports.personCapability(paths.home) });

export const connectSessionRuntime = (
  ports: Pick<DaemonPorts, 'version' | 'clock' | 'endpointScope'> & Pick<CliPorts, 'personCapability'>,
  paths: MomongaPaths,
  onNewer?: NewerListener,
  restoreConnection?: () => Promise<void>,
): RuntimeClient =>
  createRuntimeClient({
    resolveSocket: sessionSocketResolver(ports, paths, 'runtime'),
    clock: ports.clock,
    personCapability: () => ports.personCapability(paths.home),
    onMoved: endSessionWhenMovedAway(paths, ports.version, onNewer),
    ...(restoreConnection === undefined ? {} : { restoreConnection }),
  });

export const openSession = async (ports: DaemonPorts & Pick<CliPorts, 'cwd' | 'platform' | 'stderr' | 'interrupt' | 'personCapability'>, paths: MomongaPaths, options: OpenSessionOptions): Promise<CliSession> => {
  const { onNewer } = options;
  await ensureSessionDaemon(ports, paths, { ...(options.signal === undefined ? {} : { signal: options.signal }), ...(onNewer === undefined ? {} : { onNewer }) });
  const client = connectSessionRuntime(ports, paths, onNewer);
  try {
    if (options.reopen !== undefined) {
      const listed = await options.modelList();
      if (startModelOf({ count: listed.data.length, start: listed.start }) === undefined) throw new NoModelConnected();
      const reopened: CreatedSession = { session: await reopenedAsTyped(client, ports.cwd, ports.platform, options.reopen, options), strippedEnvKeys: [] };
      return { client, created: reopened, close: () => client.close() };
    }
    const created = await client.createSession({
      cwd: ports.cwd,
      env: await environmentSnapshot(ports, options.signal),
      terminalUi: false,
      ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
      ...(options.bypassAllowed === undefined ? {} : { bypassAllowed: options.bypassAllowed }),
      ...(options.sandboxNetwork === undefined ? {} : { sandboxNetwork: options.sandboxNetwork }),
      ...(options.model === undefined ? {} : { model: options.model }),
    });
    return { client, created, close: () => client.close() };
  } catch (error) {
    await client.close();
    throw error;
  }
};
