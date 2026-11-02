import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadUserSettings } from '@momonga/config';
import { ProcessLockHeldError, acquireProcessLock, ensureMomongaDirs, nodeCommandRunner } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { Agent, interceptors, request } from 'undici';
import { createSupervisorClient } from '../client/supervisor-client.ts';
import { defaultDaemonBounds, probeSupervisor } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import type { DaemonProbe, StagedFile, UpdateFs, UpdateHttp, UpdateLock, UpdatePorts, UpdateStateStore } from './ports.ts';

export const TRANSFER_STALL_TIMEOUT_MS = 30_000;
export const MAX_REDIRECTS = 5;
export const STAGING_PREFIX = '.momonga-update.';
export const UPDATE_LOCK_FILE = 'update.lock';
export const UPDATE_STATE_FILE = 'update.json';

export const undiciUpdateHttp = (): UpdateHttp => {
  const dispatcher = new Agent({ headersTimeout: TRANSFER_STALL_TIMEOUT_MS, bodyTimeout: TRANSFER_STALL_TIMEOUT_MS }).compose(
    interceptors.redirect({ maxRedirections: MAX_REDIRECTS, throwOnMaxRedirect: true }),
  );
  return {
    get: async (url, { headers, signal }) => {
      const response = await request(url, { method: 'GET', headers: { ...headers }, signal, dispatcher });
      return { status: response.statusCode, body: response.body };
    },
  };
};

const writeAll = async (handle: fs.FileHandle, chunk: Uint8Array): Promise<void> => {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    offset += bytesWritten;
  }
};

export const nodeUpdateFs = (): UpdateFs => ({
  realpath: (file) => fs.realpath(file),
  modeOf: async (file) => (await fs.stat(file)).mode & 0o777,
  stage: async (directory, mode): Promise<StagedFile> => {
    const file = path.join(directory, `${STAGING_PREFIX}${randomBytes(6).toString('hex')}`);
    const handle = await fs.open(file, 'wx', mode);
    let closed = false;
    await handle.chmod(mode);
    return {
      path: file,
      write: (chunk) => writeAll(handle, chunk),
      close: async () => {
        if (closed) return;
        closed = true;
        await handle.close();
      },
    };
  },
  publish: (staged, target) => fs.rename(staged, target),
  remove: (file) => fs.rm(file, { force: true }),
  removeLeftovers: async (directory) => {
    for (const entry of await fs.readdir(directory)) {
      if (entry.startsWith(STAGING_PREFIX)) await fs.rm(path.join(directory, entry), { force: true });
    }
  },
});

export const nodeUpdateLock = (paths: MomongaPaths): UpdateLock => ({
  acquire: async () => {
    await ensureMomongaDirs(paths);
    try {
      const lock = await acquireProcessLock(path.join(paths.run, UPDATE_LOCK_FILE));
      return { release: () => lock.release() };
    } catch (error) {
      if (error instanceof ProcessLockHeldError) return undefined;
      throw error;
    }
  },
});

export const nodeUpdateState = (paths: MomongaPaths): UpdateStateStore => {
  const file = path.join(paths.state, UPDATE_STATE_FILE);
  return {
    read: async () => {
      let text: string;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
      const parsed: unknown = JSON.parse(text);
      return parsed;
    },
    write: async (state) => {
      await ensureMomongaDirs(paths);
      const temporary = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await fs.rename(temporary, file);
    },
  };
};

export const nodeDaemonProbe = (paths: MomongaPaths): DaemonProbe => ({
  running: async () => {
    const client = createSupervisorClient({ socketPath: paths.sockets.supervisor });
    try {
      return (await probeSupervisor(client)) !== undefined;
    } finally {
      await client.close();
    }
  },
  restartBoundMs: async () => {
    const { readyMs, stopMs } = await defaultDaemonBounds();
    return readyMs + stopMs;
  },
});

const definedEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));

export const nodeUpdatePorts = (ports: CliPorts, paths: MomongaPaths): UpdatePorts => ({
  version: ports.version,
  platform: process.platform,
  arch: process.arch,
  home: ports.home,
  self: ports.self,
  env: definedEnv(ports.env),
  clock: ports.clock,
  http: undiciUpdateHttp(),
  fs: nodeUpdateFs(),
  run: nodeCommandRunner,
  lock: nodeUpdateLock(paths),
  state: nodeUpdateState(paths),
  daemon: nodeDaemonProbe(paths),
  autoUpdates: async () => (await loadUserSettings({ home: ports.home })).settings.autoUpdates,
  spawnDetached: ports.spawnDetached,
  stderr: ports.stderr,
});
