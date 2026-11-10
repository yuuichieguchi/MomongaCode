import fs from 'node:fs/promises';
import { nodeFileSystem } from '@momonga/foundation';
import type { DistributionFiles } from './z3-distribution.ts';

export const nodeDistributionFiles: DistributionFiles = {
  exists: async (target) => {
    try {
      await fs.access(target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  },
  writeBytes: (file, bytes) => fs.writeFile(file, bytes, { mode: 0o600 }),
  readFile: nodeFileSystem.readFile,
  mkdir: nodeFileSystem.mkdir,
  rm: nodeFileSystem.rm,
  rename: nodeFileSystem.rename,
};
