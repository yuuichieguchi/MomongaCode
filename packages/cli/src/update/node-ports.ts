import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadUserSettings } from '@momonga/config';
import {
  ProcessLockHeldError,
  acquireProcessLock,
  createLockedEntry,
  createOutboundDispatcher,
  resolveLayoutLocks,
  inspectProcessLock,
  listGenerations,
  nodeBoundedCommandRunner,
  nodeDescriptorWriter,
  nodeFileSystem,
  sweepLeftovers,
  systemRandom,
  writeFileAtomically,
} from '@momonga/foundation';
import type { KernelLockMechanism, LockedEntry, LockedEntryFiles, MomongaPaths, OutboundNetwork, OutboundOptions } from '@momonga/foundation';
import { interceptors, request } from 'undici';
import { withOutboundNetwork } from '../network.ts';
import { daemonReadyBoundMs } from '../daemon/ensure-daemon.ts';
import { listLiveGenerations, retiringWorkOf } from '../daemon/generations.ts';
import type { CliClock, CliPorts } from '../ports.ts';
import type { DaemonProbe, StagedFile, UpdateFs, UpdateHttp, UpdateLock, UpdatePorts, UpdateStateStore } from './ports.ts';

export const TRANSFER_STALL_TIMEOUT_MS = 30_000;
export const MAX_REDIRECTS = 5;
export const STAGING_PREFIX = '.momonga-update.';
export const UPDATE_LOCK_FILE = 'update.lock';
export const UPDATE_STATE_FILE = 'update.json';
const UPDATE_STATE_MODE = 0o600;

export const UPDATE_TRANSFER_OPTIONS: OutboundOptions = { connectReplyTimeoutMs: TRANSFER_STALL_TIMEOUT_MS, headersTimeout: TRANSFER_STALL_TIMEOUT_MS, bodyTimeout: TRANSFER_STALL_TIMEOUT_MS };

export type NetworkLease = <T>(signal: AbortSignal, use: (network: OutboundNetwork) => Promise<T>) => Promise<T>;

export const leasedUpdateHttp = (lease: NetworkLease, options: OutboundOptions, onCloseFailure: (error: unknown) => void): UpdateHttp => ({
  get: (url, { headers, signal }) =>
    new Promise((resolve, reject) => {
      let answered = false;
      lease(signal, async (network) => {
        const dispatcher = createOutboundDispatcher(network, options);
        try {
          const response = await request(url, { method: 'GET', headers: { ...headers }, signal, dispatcher: dispatcher.compose(interceptors.redirect({ maxRedirections: MAX_REDIRECTS, throwOnMaxRedirect: true })) });
          const bodyClosed = new Promise<void>((closed) => response.body.once('close', () => closed()));
          answered = true;
          resolve({ status: response.statusCode, body: response.body });
          await bodyClosed;
        } finally {
          await dispatcher.close();
        }
      }).then(undefined, (error: unknown) => {
        if (!answered) reject(error);
        else onCloseFailure(error);
      });
    }),
});

const cliUpdateHttp = (ports: CliPorts): UpdateHttp =>
  leasedUpdateHttp((signal, use) => withOutboundNetwork(ports, signal, use), UPDATE_TRANSFER_OPTIONS, (error) => {
    ports.stderr.write(`momonga: the update connection could not be closed: ${error instanceof Error ? error.message : String(error)}\n`);
  });

const REPLACE_REFUSED_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

const errorCodeOf = (error: unknown): string | undefined => {
  const code: unknown = typeof error === 'object' && error !== null ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  return typeof code === 'string' ? code : undefined;
};

type Rename = (from: string, to: string) => Promise<void>;

const publishReplacing = async (rename: Rename, staged: string, target: string): Promise<void> => {
  try {
    await rename(staged, target);
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === undefined || !REPLACE_REFUSED_CODES.has(code)) throw error;
    const aside = path.join(path.dirname(target), `${STAGING_PREFIX}${randomBytes(6).toString('hex')}`);
    await rename(target, aside);
    try {
      await rename(staged, target);
    } catch (second) {
      await rename(aside, target);
      throw second;
    }
  }
};

const isStaged = (name: string): boolean => name.startsWith(STAGING_PREFIX);

const stagingFiles: LockedEntryFiles = {
  open: async (file, flags, mode) => {
    const handle = await fs.open(file, flags, mode);
    if (mode !== undefined) await handle.chmod(mode);
    return { writeFile: (content) => handle.writeFile(content), sync: () => handle.sync(), close: () => handle.close() };
  },
  rm: (file) => fs.rm(file, { force: true }),
  descriptors: nodeDescriptorWriter,
};

export const nodeUpdateFs = (lock: KernelLockMechanism, rename: Rename = fs.rename): UpdateFs => {
  const staging = new Map<string, LockedEntry>();
  return {
    realpath: (file) => fs.realpath(file),
    modeOf: async (file) => (await fs.stat(file)).mode & 0o777,
    stage: async (directory, mode): Promise<StagedFile> => {
      const file = path.join(directory, `${STAGING_PREFIX}${randomBytes(6).toString('hex')}`);
      const entry = await createLockedEntry(stagingFiles, lock, file, mode);
      staging.set(file, entry);
      let closed = false;
      return {
        path: file,
        write: (chunk) => entry.handle.writeFile(chunk),
        close: async () => {
          if (closed) return;
          closed = true;
          await entry.handle.close();
        },
      };
    },
    publish: async (staged, target) => {
      staging.get(staged)?.assertStillNamed();
      await publishReplacing(rename, staged, target);
      staging.get(staged)?.finish();
      staging.delete(staged);
    },
    remove: async (file) => {
      const entry = staging.get(file);
      staging.delete(file);
      if (entry === undefined) await fs.rm(file, { force: true });
      else await entry.remove();
    },
    removeLeftovers: async (directory) => {
      await sweepLeftovers({ directories: [{ directory, isLeftover: isStaged }], lock });
    },
  };
};

export const nodeUpdateLock = (paths: MomongaPaths, mechanism: KernelLockMechanism): UpdateLock => {
  const lockPath = path.join(paths.run, UPDATE_LOCK_FILE);
  return {
    acquire: async () => {
      try {
        const lock = await acquireProcessLock(lockPath, undefined, { mechanism });
        return { release: () => lock.release() };
      } catch (error) {
        if (error instanceof ProcessLockHeldError) return undefined;
        throw error;
      }
    },
    isHeld: async () => (await inspectProcessLock(lockPath, { mechanism })).state !== 'free',
  };
};

export const nodeUpdateState = (paths: MomongaPaths, lock: KernelLockMechanism): UpdateStateStore => {
  const file = path.join(paths.state, UPDATE_STATE_FILE);
  return {
    file,
    read: async () => {
      try {
        return await fs.readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    write: async (state) => {
      await writeFileAtomically(nodeFileSystem, systemRandom, file, JSON.stringify(state), { mode: UPDATE_STATE_MODE, lock });
    },
  };
};

export const nodeDaemonProbe = (paths: MomongaPaths, clock: CliClock, lock: KernelLockMechanism): DaemonProbe => ({
  running: async () => (await listGenerations(paths, { lock })).some((listed) => listed.live),
  retiring: async () => retiringWorkOf(await listLiveGenerations({ clock }, paths, { lock })),
  readyBoundMs: () => daemonReadyBoundMs(),
});

const definedEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));

export const nodeUpdatePorts = (ports: CliPorts, paths: MomongaPaths, lock: KernelLockMechanism = resolveLayoutLocks(paths).mechanism): UpdatePorts => ({
  version: ports.version,
  platform: ports.platform,
  arch: process.arch,
  home: ports.home,
  self: ports.self,
  env: definedEnv(ports.env),
  clock: ports.clock,
  http: cliUpdateHttp(ports),
  fs: nodeUpdateFs(lock),
  run: nodeBoundedCommandRunner,
  lock: nodeUpdateLock(paths, lock),
  state: nodeUpdateState(paths, lock),
  daemon: nodeDaemonProbe(paths, ports.clock, lock),
  autoUpdates: async () => (await loadUserSettings({ home: ports.home, signal: ports.interrupt })).settings.autoUpdates,
  spawnDetached: ports.spawnDetached,
  stderr: ports.stderr,
});
