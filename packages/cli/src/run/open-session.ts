import { credentialEnvNames, loadUserSettings, stripCredentialEnv } from '@momonga/config';
import { currentSocketResolver } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import type { PermissionMode } from '@momonga/protocol';
import { createRuntimeClient } from '../client/runtime-client.ts';
import type { CreatedSession, RuntimeClient } from '../client/runtime-client.ts';
import { ensureSessionDaemon } from '../daemon/ensure-daemon.ts';
import { endSessionWhenMovedAway, sessionSocketResolver } from '../daemon/generations.ts';
import type { CliPorts } from '../ports.ts';
import type { DaemonPorts, NewerListener } from '../daemon/ensure-daemon.ts';
import { reopenedSession } from './resolve-session.ts';
import type { HeadlessReopen } from './resolve-session.ts';

export type SessionOptions = { permissionMode?: PermissionMode; bypassAllowed?: boolean; model?: string; signal?: AbortSignal };

export type OpenSessionOptions = SessionOptions & { reopen?: HeadlessReopen; onNewer?: NewerListener };

export type CliSession = {
  client: RuntimeClient;
  created: CreatedSession;
  close(): Promise<void>;
};

export const environmentSnapshot = async (ports: Pick<CliPorts, 'env' | 'home'>, signal: AbortSignal): Promise<Record<string, string>> => {
  const { settings } = await loadUserSettings({ home: ports.home, signal });
  const defined = Object.fromEntries(Object.entries(ports.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return stripCredentialEnv(defined, credentialEnvNames(settings.models), settings.credentials).env;
};

export const autoModeConfigured = async (ports: Pick<CliPorts, 'home'>, signal: AbortSignal): Promise<boolean> => {
  const { settings } = await loadUserSettings({ home: ports.home, signal });
  return settings.autoMode?.classifier !== undefined;
};

export const connectRuntime = (ports: Pick<CliPorts, 'clock'>, paths: MomongaPaths): RuntimeClient => createRuntimeClient({ resolveSocket: currentSocketResolver(paths, 'runtime'), clock: ports.clock });

export const connectSessionRuntime = (ports: Pick<DaemonPorts, 'version' | 'clock'>, paths: MomongaPaths, onNewer?: NewerListener): RuntimeClient =>
  createRuntimeClient({ resolveSocket: sessionSocketResolver(paths, ports.version, 'runtime'), clock: ports.clock, onMoved: endSessionWhenMovedAway(paths, ports.version, onNewer) });

export const openSession = async (ports: DaemonPorts & Pick<CliPorts, 'cwd' | 'stderr' | 'interrupt'>, paths: MomongaPaths, options: OpenSessionOptions): Promise<CliSession> => {
  const { onNewer } = options;
  await ensureSessionDaemon(ports, paths, { ...(options.signal === undefined ? {} : { signal: options.signal }), ...(onNewer === undefined ? {} : { onNewer }) });
  const client = connectSessionRuntime(ports, paths, onNewer);
  try {
    if (options.reopen !== undefined) {
      const reopened: CreatedSession = { session: await reopenedSession(client, ports.cwd, options.reopen), strippedEnvKeys: [] };
      return { client, created: reopened, close: () => client.close() };
    }
    const created = await client.createSession({
      cwd: ports.cwd,
      env: await environmentSnapshot(ports, options.signal ?? ports.interrupt),
      ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
      ...(options.bypassAllowed === undefined ? {} : { bypassAllowed: options.bypassAllowed }),
      ...(options.model === undefined ? {} : { model: options.model }),
    });
    return { client, created, close: () => client.close() };
  } catch (error) {
    await client.close();
    throw error;
  }
};
