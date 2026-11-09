import fs from 'node:fs';
import path from 'node:path';
import { EntryUsageError, nodeFileSystem, systemClock } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import type { GatewayTimers } from './types.ts';

export type ProcessFilePorts = {
  isUsableBinary(file: string): Promise<boolean>;
  readDebugToken(tokenFile: string): string;
  databaseExists(file: string): boolean;
  readTextFile(file: string): Promise<string>;
};

export type ProcessPorts = {
  clock: Clock;
  timers: GatewayTimers;
  random: () => number;
  files: ProcessFilePorts;
};

const GROUP_AND_OTHER_BITS = 0o077;

export const realTimers: GatewayTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export const systemProcessFiles: ProcessFilePorts = {
  readTextFile: nodeFileSystem.readTextFile,
  isUsableBinary: async (file) => {
    try {
      await fs.promises.access(file, fs.constants.R_OK | fs.constants.X_OK);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES') return false;
      throw error;
    }
  },
  readDebugToken: (tokenFile) => {
    if (!path.isAbsolute(tokenFile)) throw new EntryUsageError(`--debug-tcp-token-file must be an absolute path, got ${tokenFile}`);
    const mode = fs.statSync(tokenFile).mode;
    if ((mode & GROUP_AND_OTHER_BITS) !== 0) throw new EntryUsageError(`${tokenFile} must not be readable by group or others`);
    const token = fs.readFileSync(tokenFile, 'utf8').replace(/\n$/, '');
    if (token === '') throw new EntryUsageError(`${tokenFile} holds an empty token`);
    return token;
  },
  databaseExists: (file) => fs.existsSync(file),
};

export const systemProcessPorts: ProcessPorts = {
  clock: systemClock,
  timers: realTimers,
  random: Math.random,
  files: systemProcessFiles,
};
