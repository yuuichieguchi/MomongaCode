import { createHostExec, minimalChildEnv, nodeFileSystem } from '@momonga/foundation';
import type { HostExec } from '@momonga/foundation';
import { registeredServers } from '@momonga/config';
import type { ServerRegistry } from '@momonga/config';
import type { ManagedServerDescription } from '@momonga/protocol';

const fileExists = async (file: string): Promise<boolean> => {
  try {
    await nodeFileSystem.stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

export const localManagedPorts = (registry: ServerRegistry): { servers: readonly ManagedServerDescription[]; exec: HostExec; exists(file: string): Promise<boolean> } => ({
  servers: registeredServers(registry),
  exec: createHostExec(minimalChildEnv(process.env)),
  exists: fileExists,
});
