import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXTERNAL_CLI_PATH_ENV, EntryUsageError, NETWORK_ENV_NAMES, createPathResolver, minimalChildEnv, nodeFileSystem, systemTiming } from '@momonga/foundation';
import type { Clock, PathResolver, Timing } from '@momonga/foundation';
import type { CliChildProcess, SpawnCliProcess } from './adapters/cli-subprocess/adapter.ts';
import type { ExternalCliExecResult, ExternalCliStatusExec } from './adapters/cli-subprocess/status.ts';
import { PLAN_SIGN_IN_DEFAULTS } from './defaults.ts';
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

const currentUsername = (): string | undefined => {
  try {
    const name = os.userInfo().username;
    return name === '' ? undefined : name;
  } catch {
    return undefined;
  }
};

export const externalCliEnv = (env: NodeJS.ProcessEnv = process.env): Record<string, string> => {
  const result: Record<string, string> = { ...minimalChildEnv(env) };
  for (const name of NETWORK_ENV_NAMES) {
    const value = env[name];
    if (value !== undefined) result[name] = value;
  }
  const user = env['USER'] && env['USER'] !== '' ? env['USER'] : currentUsername();
  if (user !== undefined) result['USER'] = user;
  const logname = env['LOGNAME'] && env['LOGNAME'] !== '' ? env['LOGNAME'] : user;
  if (logname !== undefined) result['LOGNAME'] = logname;
  const dbus = env['DBUS_SESSION_BUS_ADDRESS'];
  if (dbus !== undefined && dbus !== '') result['DBUS_SESSION_BUS_ADDRESS'] = dbus;
  const cliPath = env[EXTERNAL_CLI_PATH_ENV] ?? env['PATH'];
  if (cliPath !== undefined && cliPath !== '') result['PATH'] = cliPath;
  return result;
};

export const createCliProcessSpawner = (env: NodeJS.ProcessEnv = process.env): SpawnCliProcess => {
  const childEnv = externalCliEnv(env);
  return (command, args) => spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv }) as unknown as CliChildProcess;
};

export const createExternalCliStatusExec = (
  env: NodeJS.ProcessEnv = process.env,
  timers: Pick<Timing, 'setTimeout' | 'clearTimeout'> = realTimers,
): ExternalCliStatusExec => {
  const childEnv = externalCliEnv(env);
  return (command, args, signal) =>
    new Promise<ExternalCliExecResult>((resolve) => {
      let settled = false;
      const finish = (result: ExternalCliExecResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') finish({ kind: 'missing' });
        else finish({ kind: 'exited', code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
        return;
      }
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutBytes < PLAN_SIGN_IN_DEFAULTS.authBodyBytes) {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.byteLength;
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBytes < PLAN_SIGN_IN_DEFAULTS.authBodyBytes) {
          stderrChunks.push(chunk);
          stderrBytes += chunk.byteLength;
        }
      });
      const onAbort = (): void => {
        child.kill('SIGTERM');
      };
      const timer = timers.setTimeout(() => {
        child.kill('SIGTERM');
      }, PLAN_SIGN_IN_DEFAULTS.keysTimeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', (error: NodeJS.ErrnoException) => {
        timers.clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (error.code === 'ENOENT') finish({ kind: 'missing' });
        else finish({ kind: 'exited', code: 1, stdout: '', stderr: error.message });
      });
      child.on('close', (code) => {
        timers.clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        finish({
          kind: 'exited',
          code,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        });
      });
    });
};
