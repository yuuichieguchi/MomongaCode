import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Agent, request } from 'undici';
import { acquireProcessLock } from './process-lock.ts';
import type { AcquireProcessLockOptions } from './process-lock.ts';
import { modeIsPrivate, ownerProblem } from './platform/privacy.ts';
import { assertSocketPathLength, isPipePath } from './socket-path.ts';

export interface UdsRequestOptions {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}

export interface UdsResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface UdsClient {
  request(options: UdsRequestOptions): Promise<UdsResponse>;
  close(): Promise<void>;
  destroy(): Promise<void>;
}

export interface UdsClientOptions {
  headersTimeoutMs?: number;
  bodyTimeoutMs?: number;
}

export const createUdsClient = (socketPath: string, options: UdsClientOptions = {}): UdsClient => {
  const agent = new Agent({
    connect: { socketPath },
    ...(options.headersTimeoutMs === undefined ? {} : { headersTimeout: options.headersTimeoutMs }),
    ...(options.bodyTimeoutMs === undefined ? {} : { bodyTimeout: options.bodyTimeoutMs }),
  });
  let closing: Promise<void> | undefined;
  let destroying: Promise<void> | undefined;
  return {
    request: async (options) => {
      const response = await request(`http://localhost${options.path}`, {
        dispatcher: agent,
        method: options.method as 'GET',
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
      }
      return {
        status: response.statusCode,
        headers,
        body: response.body,
        text: () => response.body.text(),
        json: () => response.body.json(),
      };
    },
    close: () => {
      closing ??= agent.close();
      return closing;
    },
    destroy: () => {
      destroying ??= agent.destroy().then(() => undefined);
      return destroying;
    },
  };
};

export const isUnixSocketLive = (socketPath: string): Promise<boolean> =>
  new Promise((resolve, reject) => {
    const probe = net.connect(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', (error: NodeJS.ErrnoException) => {
      probe.destroy();
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false);
      else reject(error);
    });
  });

const listen = (server: net.Server, socketPath: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });

const listenPipe = async (server: net.Server, pipePath: string): Promise<void> => {
  try {
    await listen(server, pipePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`${pipePath} is already in use by a live server`, { cause: error });
    throw error;
  }
};

export const listenUnix = async (server: net.Server, socketPath: string, lockOptions?: AcquireProcessLockOptions): Promise<void> => {
  assertSocketPathLength(socketPath);
  if (isPipePath(socketPath)) return listenPipe(server, socketPath);
  const directory = path.dirname(socketPath);
  const directoryStat = await fs.promises.lstat(directory);
  if (directoryStat.isSymbolicLink()) throw new Error(`Socket directory ${directory} is a symlink; refusing to listen in it`);
  if (!directoryStat.isDirectory()) throw new Error(`Socket directory ${directory} is not a directory`);
  const owner = ownerProblem(directoryStat);
  if (owner !== undefined) {
    throw new Error(`Socket directory ${directory} is owned by uid ${owner.found}, but the current user is uid ${owner.expected}; the directory must be owned by the current user`);
  }
  if (!modeIsPrivate(directoryStat, 'directory')) {
    throw new Error(`Socket directory ${directory} must have mode 0700, found ${(directoryStat.mode & 0o777).toString(8)}`);
  }
  const lockPath = `${socketPath}.lock`;
  const lock = await acquireProcessLock(lockPath, async (pid) => {
    const listening = await isUnixSocketLive(socketPath);
    const suspicion = listening ? '' : ' and nothing is listening on the socket, so the lock is suspected stale';
    return `${socketPath} is already in use by process ${pid} (lock ${lockPath})${suspicion}; remove ${lockPath} if process ${pid} is not momonga`;
  }, lockOptions);
  try {
    const existing = await fs.promises.lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing !== undefined) {
      if (!existing.isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
      if (await isUnixSocketLive(socketPath)) throw new Error(`${socketPath} is already in use by a live server`);
      await fs.promises.unlink(socketPath);
    }
    await listen(server, socketPath);
    await fs.promises.chmod(socketPath, 0o600);
  } catch (error) {
    lock.release();
    throw error;
  }
  server.once('close', () => lock.release());
};
