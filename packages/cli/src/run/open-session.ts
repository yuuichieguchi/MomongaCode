import { credentialEnvNames, loadUserSettings, stripCredentialEnv } from '@momonga/config';
import type { MomongaPaths } from '@momonga/foundation';
import type { PermissionMode } from '@momonga/protocol';
import { createRuntimeClient } from '../client/runtime-client.ts';
import type { CreatedSession, RuntimeClient } from '../client/runtime-client.ts';
import { ensureDaemon } from '../daemon/ensure-daemon.ts';
import { stderrStopNotice } from '../daemon/stop-notice.ts';
import type { CliPorts } from '../ports.ts';
import type { DaemonPorts } from '../daemon/ensure-daemon.ts';

export type SessionOptions = { permissionMode?: PermissionMode; bypassAllowed?: boolean; modelAlias?: string; signal?: AbortSignal };

export type CliSession = {
  client: RuntimeClient;
  created: CreatedSession;
  close(): Promise<void>;
};

export const environmentSnapshot = async (ports: Pick<DaemonPorts, 'env' | 'home'>): Promise<Record<string, string>> => {
  const { settings } = await loadUserSettings({ home: ports.home });
  const defined = Object.fromEntries(Object.entries(ports.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return stripCredentialEnv(defined, credentialEnvNames(settings), settings.credentials).env;
};

export const autoModeConfigured = async (ports: Pick<DaemonPorts, 'home'>): Promise<boolean> => {
  const { settings } = await loadUserSettings({ home: ports.home });
  return settings.autoMode?.classifier !== undefined;
};

export const connectRuntime = (paths: MomongaPaths): RuntimeClient => createRuntimeClient({ socketPath: paths.sockets.runtime });

export const openSession = async (ports: DaemonPorts & Pick<CliPorts, 'cwd' | 'stderr'>, paths: MomongaPaths, options: SessionOptions): Promise<CliSession> => {
  const onNotice = stderrStopNotice(ports);
  await ensureDaemon(ports, paths, options.signal === undefined ? { onNotice } : { signal: options.signal, onNotice });
  const client = connectRuntime(paths);
  try {
    const created = await client.createSession({
      cwd: ports.cwd,
      env: await environmentSnapshot(ports),
      ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
      ...(options.bypassAllowed === undefined ? {} : { bypassAllowed: options.bypassAllowed }),
      ...(options.modelAlias === undefined ? {} : { modelAlias: options.modelAlias }),
    });
    return { client, created, close: () => client.close() };
  } catch (error) {
    await client.close();
    throw error;
  }
};
