import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Agent, request } from 'undici';

const SOCKET_PATH_LIMIT = 104;

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
}

export const createUdsClient = (socketPath: string): UdsClient => {
  const agent = new Agent({ connect: { socketPath } });
  let closing: Promise<void> | undefined;
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

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
};

const GARBLED_LOCK_GRACE_MS = 2000;
const ABANDONED_TAKEOVER_MS = 10000;
const LOCK_RETRY_MS = 25;

type LockState =
  | { kind: 'missing' }
  | { kind: 'pid'; pid: number }
  | { kind: 'garbled'; ageMs: number };

const readLockState = async (lockPath: string): Promise<LockState> => {
  let raw: string;
  let modifiedAt: number;
  try {
    raw = await fs.promises.readFile(lockPath, 'utf8');
    modifiedAt = (await fs.promises.stat(lockPath)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  const pid = Number.parseInt(raw, 10);
  if (Number.isInteger(pid) && pid > 0) return { kind: 'pid', pid };
  return { kind: 'garbled', ageMs: Date.now() - modifiedAt };
};

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const tryCreateLock = async (lockPath: string): Promise<boolean> => {
  const temporary = `${lockPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.promises.writeFile(temporary, String(process.pid), { flag: 'wx', mode: 0o600 });
  try {
    await fs.promises.link(temporary, lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
};

const sameState = (current: LockState, observed: LockState): boolean =>
  current.kind === observed.kind && (current.kind !== 'pid' || (observed.kind === 'pid' && current.pid === observed.pid));

const removeStaleLock = async (lockPath: string, observed: LockState): Promise<void> => {
  const mutex = `${lockPath}.takeover`;
  try {
    await fs.promises.mkdir(mutex, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const age = await fs.promises.stat(mutex).then(
      (stat) => Date.now() - stat.mtimeMs,
      (statError: NodeJS.ErrnoException) => {
        if (statError.code === 'ENOENT') return 0;
        throw statError;
      },
    );
    if (age > ABANDONED_TAKEOVER_MS) await fs.promises.rm(mutex, { recursive: true, force: true });
    else await pause(LOCK_RETRY_MS);
    return;
  }
  try {
    if (sameState(await readLockState(lockPath), observed)) await fs.promises.rm(lockPath, { force: true });
  } finally {
    await fs.promises.rm(mutex, { recursive: true, force: true });
  }
};

const acquireLock = async (lockPath: string, socketPath: string): Promise<void> => {
  for (;;) {
    if (await tryCreateLock(lockPath)) return;
    const state = await readLockState(lockPath);
    if (state.kind === 'missing') continue;
    if (state.kind === 'garbled') {
      if (state.ageMs > GARBLED_LOCK_GRACE_MS) await removeStaleLock(lockPath, state);
      else await pause(LOCK_RETRY_MS);
      continue;
    }
    if (!isProcessAlive(state.pid)) {
      await removeStaleLock(lockPath, state);
      continue;
    }
    const listening = await isUnixSocketLive(socketPath);
    const suspicion = listening ? '' : ' and nothing is listening on the socket, so the lock is suspected stale';
    throw new Error(
      `${socketPath} is already in use by process ${state.pid} (lock ${lockPath})${suspicion}; remove ${lockPath} if process ${state.pid} is not momonga`,
    );
  }
};

const releaseLock = (lockPath: string): void => {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (Number.parseInt(raw, 10) !== process.pid) return;
  fs.rmSync(lockPath, { force: true });
};

const listen = (server: net.Server, socketPath: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });

export const listenUnix = async (server: net.Server, socketPath: string): Promise<void> => {
  const byteLength = Buffer.byteLength(socketPath);
  if (byteLength >= SOCKET_PATH_LIMIT) {
    throw new Error(
      `Unix socket path is ${byteLength} bytes; it must be shorter than ${SOCKET_PATH_LIMIT} bytes: ${socketPath}`,
    );
  }
  const directory = path.dirname(socketPath);
  const directoryMode = (await fs.promises.stat(directory)).mode & 0o777;
  if (directoryMode !== 0o700) {
    throw new Error(`Socket directory ${directory} must have mode 0700, found ${directoryMode.toString(8)}`);
  }
  const lockPath = `${socketPath}.lock`;
  await acquireLock(lockPath, socketPath);
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
    releaseLock(lockPath);
    throw error;
  }
  server.once('close', () => releaseLock(lockPath));
};
