import fs from 'node:fs/promises';
import { createHostExec, minimalChildEnv } from '@momonga/foundation';
import { MANAGED_SERVERS } from '@momonga/protocol';
import type { ExecFn } from '@momonga/gateway';
import type { ManagedServerDescription } from '@momonga/protocol';

const fileExists = async (file: string): Promise<boolean> => {
  try {
    await fs.stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

export const localManagedPorts = (): { servers: readonly ManagedServerDescription[]; exec: ExecFn; exists(file: string): Promise<boolean> } => ({
  servers: MANAGED_SERVERS,
  exec: createHostExec(minimalChildEnv(process.env)),
  exists: fileExists,
});
