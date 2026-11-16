import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Agent, buildConnector, request } from 'undici';
import { GENERATION_RETIRED_CODE } from './generation-codes.ts';
import { acquireProcessLock } from './process-lock.ts';
import type { AcquireProcessLockOptions } from './process-lock.ts';
import { modeIsPrivate, ownerProblem } from './platform/privacy.ts';
import { assertScopedPipePath, assertSocketPathLength, assertUnixSocketPathFits, isPipePath } from './socket-path.ts';

export interface UdsRequestOptions {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
  bodyTimeoutMs?: number;
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
  connectTimeoutMs: number;
  headersTimeoutMs?: number;
  bodyTimeoutMs?: number;
}

export type SocketResolver = () => Promise<string>;

export const fixedSocket =
  (socketPath: string): SocketResolver =>
  () =>
    Promise.resolve(socketPath);

const dialResolved =
  (resolveSocket: SocketResolver, connectTimeoutMs: number): buildConnector.connector =>
  (connectOptions, callback) => {
    void resolveSocket()
      .then((socketPath) => {
        if (isPipePath(socketPath)) assertScopedPipePath(socketPath);
        buildConnector({ socketPath, timeout: connectTimeoutMs })(connectOptions, callback);
      })
      .catch((error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), null));
  };

const isRetiredValue = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && (value as { error?: { code?: unknown } }).error?.code === GENERATION_RETIRED_CODE;

const isRetiredText = (text: string): boolean => {
  try {
    return isRetiredValue(JSON.parse(text));
  } catch {
    return false;
  }
};

export const createUdsClient = (resolveSocket: SocketResolver, options: UdsClientOptions): UdsClient => {
  const newAgent = (): Agent =>
    new Agent({
      connect: dialResolved(resolveSocket, options.connectTimeoutMs),
      ...(options.headersTimeoutMs === undefined ? {} : { headersTimeout: options.headersTimeoutMs }),
      ...(options.bodyTimeoutMs === undefined ? {} : { bodyTimeout: options.bodyTimeoutMs }),
    });
  let agent = newAgent();
  let closing: Promise<void> | undefined;
  let destroying: Promise<void> | undefined;
  const retireAgent = (used: Agent): void => {
    if (used === agent) agent = newAgent();
    void used.close();
  };
  return {
    request: async (options) => {
      const used = agent;
      const response = await request(`http://localhost${options.path}`, {
        dispatcher: used,
        method: options.method as 'GET',
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.bodyTimeoutMs === undefined ? {} : { bodyTimeout: options.bodyTimeoutMs }),
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
        text: async () => {
          const text = await response.body.text();
          if (isRetiredText(text)) retireAgent(used);
          return text;
        },
        json: async () => {
          const value: unknown = await response.body.json();
          if (isRetiredValue(value)) retireAgent(used);
          return value;
        },
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

export const isUnixSocketLive = (socketPath: string, signal: AbortSignal): Promise<boolean> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const probe = net.connect(socketPath);
    const onAbort = (): void => {
      probe.destroy();
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const settle = (): void => {
      signal.removeEventListener('abort', onAbort);
      probe.destroy();
    };
    probe.once('connect', () => {
      settle();
      resolve(true);
    });
    probe.once('error', (error: NodeJS.ErrnoException) => {
      settle();
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
  assertScopedPipePath(pipePath);
  try {
    await listen(server, pipePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`${pipePath} is already in use by a live server`, { cause: error });
    throw error;
  }
};

export const listenUnix = async (server: net.Server, socketPath: string, lockOptions: AcquireProcessLockOptions, signal: AbortSignal): Promise<void> => {
  if (!(signal instanceof AbortSignal)) throw new TypeError(`listening on ${socketPath} needs the signal of the operation that asked for it`);
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
  await assertUnixSocketPathFits(socketPath);
  const lockPath = `${socketPath}.lock`;
  const lock = await acquireProcessLock(
    lockPath,
    async (pid) => `${socketPath} is already in use by ${pid === undefined ? 'another process' : `process ${pid}`} (lock ${lockPath})`,
    lockOptions,
  );
  try {
    const existing = await fs.promises.lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing !== undefined) {
      if (!existing.isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
      if (await isUnixSocketLive(socketPath, signal)) throw new Error(`${socketPath} is already in use by a live server`);
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
