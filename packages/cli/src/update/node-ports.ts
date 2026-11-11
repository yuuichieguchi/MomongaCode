import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadUserSettings } from '@momonga/config';
import {
  ProcessLockHeldError,
  acquireProcessLock,
  createLockedEntry,
  createOutboundDispatcher,
  hostKernelLock,
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
import type { Dispatcher } from 'undici';
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

const TRANSFER_OPTIONS: OutboundOptions = { connectReplyTimeoutMs: TRANSFER_STALL_TIMEOUT_MS, headersTimeout: TRANSFER_STALL_TIMEOUT_MS, bodyTimeout: TRANSFER_STALL_TIMEOUT_MS };

const redirectingDispatcher = (network: OutboundNetwork, options: OutboundOptions): Dispatcher =>
  createOutboundDispatcher(network, options).compose(interceptors.redirect({ maxRedirections: MAX_REDIRECTS, throwOnMaxRedirect: true }));

export const undiciUpdateHttp = (network: Promise<OutboundNetwork>, options: OutboundOptions = TRANSFER_OPTIONS): UpdateHttp => {
  let dispatcher: Promise<Dispatcher> | undefined;
  const dispatcherOnce = (): Promise<Dispatcher> => {
    dispatcher ??= network.then((resolved) => redirectingDispatcher(resolved, options));
    return dispatcher;
  };
  return {
    get: async (url, { headers, signal }) => {
      const response = await request(url, { method: 'GET', headers: { ...headers }, signal, dispatcher: await dispatcherOnce() });
      return { status: response.statusCode, body: response.body };
    },
  };
};

const leasedUpdateHttp = (ports: CliPorts): UpdateHttp => ({
  get: (url, { headers, signal }) =>
    new Promise((resolve, reject) => {
      let answered = false;
      withOutboundNetwork(ports, signal, async (network) => {
        const dispatcher = createOutboundDispatcher(network, TRANSFER_OPTIONS);
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
        else ports.stderr.write(`momonga: the update connection could not be closed: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }),
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

export const nodeUpdateFs = (rename: Rename = fs.rename, lock: KernelLockMechanism = hostKernelLock()): UpdateFs => {
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

export const nodeUpdateLock = (paths: MomongaPaths): UpdateLock => {
  const lockPath = path.join(paths.run, UPDATE_LOCK_FILE);
  return {
    acquire: async () => {
      try {
        const lock = await acquireProcessLock(lockPath);
        return { release: () => lock.release() };
      } catch (error) {
        if (error instanceof ProcessLockHeldError) return undefined;
        throw error;
      }
    },
    isHeld: async () => (await inspectProcessLock(lockPath)).state !== 'free',
  };
};

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
      await writeFileAtomically(nodeFileSystem, systemRandom, file, JSON.stringify(state), { mode: UPDATE_STATE_MODE });
    },
  };
};

export const nodeDaemonProbe = (paths: MomongaPaths, clock: CliClock): DaemonProbe => ({
  running: async () => (await listGenerations(paths, { lock: hostKernelLock() })).some((listed) => listed.live),
  retiring: async () => retiringWorkOf(await listLiveGenerations({ clock }, paths)),
  readyBoundMs: () => daemonReadyBoundMs(),
});

const definedEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));

export const nodeUpdatePorts = (ports: CliPorts, paths: MomongaPaths): UpdatePorts => ({
  version: ports.version,
  platform: ports.platform,
  arch: process.arch,
  home: ports.home,
  self: ports.self,
  env: definedEnv(ports.env),
  clock: ports.clock,
  http: leasedUpdateHttp(ports),
  fs: nodeUpdateFs(),
  run: nodeBoundedCommandRunner,
  lock: nodeUpdateLock(paths),
  state: nodeUpdateState(paths),
  daemon: nodeDaemonProbe(paths, ports.clock),
  autoUpdates: async () => (await loadUserSettings({ home: ports.home, signal: ports.interrupt })).settings.autoUpdates,
  spawnDetached: ports.spawnDetached,
  stderr: ports.stderr,
});
