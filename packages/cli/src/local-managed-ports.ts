import type { HostExec } from '@momonga/foundation';
import { registeredServers } from '@momonga/config';
import type { ServerRegistry } from '@momonga/config';
import type { ManagedServerDescription } from '@momonga/protocol';
import type { CliFiles, CliPorts } from './ports.ts';

export type LocalManagedSource = { exec: CliPorts['exec']; files: Pick<CliFiles, 'exists'> };

export const localManagedPorts = (
  registry: ServerRegistry,
  ports: LocalManagedSource,
): { servers: readonly ManagedServerDescription[]; exec: HostExec; exists(file: string): Promise<boolean> } => ({
  servers: registeredServers(registry),
  exec: ports.exec,
  exists: ports.files.exists,
});
