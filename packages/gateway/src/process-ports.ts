import fs from 'node:fs';
import path from 'node:path';
import { EntryUsageError, createPathResolver, nodeFileSystem, systemTiming } from '@momonga/foundation';
import type { Clock, PathResolver } from '@momonga/foundation';
import type { GatewayTimers } from './types.ts';

export type ProcessFilePorts = {
  isUsableBinary(file: string): Promise<boolean>;
  paths(signal: AbortSignal): PathResolver;
  readDebugToken(tokenFile: string): string;
  databaseExists(file: string): boolean;
  readTextFile(file: string): Promise<string>;
};

export type ProcessPorts = {
  clock: Clock & { monotonicMs(): number };
  timers: GatewayTimers;
  random: () => number;
  files: ProcessFilePorts;
  pid: number;
};

export type HostTimers = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  release(handle: unknown): void;
};

const GROUP_AND_OTHER_BITS = 0o077;

const HOST_TIMER_LIMIT_MS = 2_147_483_647;

const TIMEOUT_REASON = 'The operation was aborted due to timeout';

class ChainedTimer {
  link: unknown;
}

export const createGatewayTimers = (host: HostTimers): GatewayTimers => {
  const start = (callback: () => void, ms: number, held: boolean): ChainedTimer => {
    const timer = new ChainedTimer();
    const arm = (remainingMs: number): void => {
      const stepMs = Math.min(remainingMs, HOST_TIMER_LIMIT_MS);
      timer.link = host.setTimeout(() => (remainingMs > stepMs ? arm(remainingMs - stepMs) : callback()), stepMs);
      if (!held) host.release(timer.link);
    };
    arm(ms);
    return timer;
  };
  return {
    setTimeout: (callback, ms) => start(callback, ms, true),
    clearTimeout: (handle) => {
      if (handle instanceof ChainedTimer) host.clearTimeout(handle.link);
    },
    timeoutSignal: (ms) => {
      const controller = new AbortController();
      start(() => controller.abort(new DOMException(TIMEOUT_REASON, 'TimeoutError')), ms, false);
      return controller.signal;
    },
  };
};

export const realTimers: GatewayTimers = createGatewayTimers({
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  release: (handle) => void (handle as NodeJS.Timeout).unref(),
});

export const systemProcessFiles: ProcessFilePorts = {
  readTextFile: nodeFileSystem.readTextFile,
  paths: (signal) => createPathResolver(nodeFileSystem, signal),
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
  clock: systemTiming,
  timers: realTimers,
  random: Math.random,
  files: systemProcessFiles,
  pid: process.pid,
};
