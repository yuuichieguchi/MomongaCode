import fs from 'node:fs/promises';
import path from 'node:path';
import { readUserAutoUpdates, readUserUpdateSettings } from '@momonga/config';
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
  replaceExecutable,
  sweepLeftovers,
  systemRandom,
  writeFileAtomically,
} from '@momonga/foundation';
import type { KernelLockMechanism, LockedEntry, LockedEntryFiles, MomongaPaths, OutboundNetwork, OutboundOptions } from '@momonga/foundation';
import { interceptors, request } from 'undici';
import { withOutboundNetwork } from '../network.ts';
import { daemonReadyBoundMs } from '../daemon/ensure-daemon.ts';
import { stderrStopNotice } from '../daemon/stop-notice.ts';
import { listLiveGenerations, retiringWorkOf } from '../daemon/generations.ts';
import type { CliClock, CliPorts } from '../ports.ts';
import type { DaemonProbe, StagedFile, UpdateFs, UpdateHttp, UpdateLock, UpdatePorts, UpdateStateStore } from './ports.ts';

export const MAX_REDIRECTS = 5;
export const STAGING_PREFIX = '.momonga-update.';
export const UPDATE_LOCK_FILE = 'update.lock';
export const UPDATE_STATE_FILE = 'update.json';
const UPDATE_STATE_MODE = 0o600;

export const transferOptionsOf = (stallTimeoutMs: number): OutboundOptions => ({ connectReplyTimeoutMs: stallTimeoutMs, headersTimeout: stallTimeoutMs, bodyTimeout: stallTimeoutMs });

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

const cliUpdateHttp = (ports: CliPorts): UpdateHttp => ({
  get: async (url, options) => {
    const { stallTimeoutMs } = await readUserUpdateSettings({ env: process.env, home: ports.home, signal: options.signal });
    return leasedUpdateHttp((signal, use) => withOutboundNetwork(ports, signal, use), transferOptionsOf(stallTimeoutMs), (error) => {
      ports.stderr.write(`momonga: the update connection could not be closed: ${error instanceof Error ? error.message : String(error)}\n`);
    }).get(url, options);
  },
});

type Rename = (from: string, to: string) => Promise<void>;

const STAGED_NAME_BYTES = 6;

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
      const file = path.join(directory, `${STAGING_PREFIX}${systemRandom.hex(STAGED_NAME_BYTES)}`);
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
      await replaceExecutable(rename, lock, staged, target, path.join(path.dirname(target), `${STAGING_PREFIX}${systemRandom.hex(STAGED_NAME_BYTES)}`));
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

export const nodeDaemonProbe = (paths: MomongaPaths, ports: Pick<CliPorts, 'clock' | 'endpointScope' | 'env' | 'home' | 'stderr'>, lock: KernelLockMechanism): DaemonProbe => ({
  running: async () => (await listGenerations(paths, { lock })).some((listed) => listed.live),
  retiring: async () => retiringWorkOf(await listLiveGenerations(ports, paths, { lock })),
  readyBoundMs: () => daemonReadyBoundMs(ports, stderrStopNotice(ports)),
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
  daemon: nodeDaemonProbe(paths, ports, lock),
  autoUpdates: () => readUserAutoUpdates({ env: process.env, home: ports.home, signal: ports.interrupt }),
  spawnDetached: ports.spawnDetached,
  stderr: ports.stderr,
});
