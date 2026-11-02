import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { comparablePath } from '../path-compare.ts';
import { noFollowFlag } from './privacy.ts';
import { UnsupportedPlatformError } from './process-inspector.ts';

export type HeldKernelLock = {
  readonly descriptor: number | undefined;
  writeHolder(text: string): void;
  release(): void;
};

export type ClaimOutcome = { kind: 'claimed'; lock: HeldKernelLock } | { kind: 'held' };

export interface KernelLockMechanism {
  readonly name: 'file-lock' | 'abstract-socket' | 'named-pipe';
  claim(lockPath: string): Promise<ClaimOutcome>;
  isHeld(lockPath: string): Promise<boolean>;
  readonly claimInheritable: ((lockPath: string) => ClaimOutcome) | undefined;
}

const O_SHLOCK = 0x10;
const O_EXLOCK = 0x20;

const WOULD_BLOCK = 'EAGAIN';

const claimFile = (lockPath: string): ClaimOutcome => {
  const { O_RDWR, O_CREAT, O_NONBLOCK, O_NOFOLLOW } = fs.constants;
  let descriptor: number;
  try {
    descriptor = fs.openSync(lockPath, O_RDWR | O_CREAT | O_EXLOCK | O_NONBLOCK | O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === WOULD_BLOCK) return { kind: 'held' };
    throw error;
  }
  let open = true;
  return {
    kind: 'claimed',
    lock: {
      descriptor,
      writeHolder: (text) => {
        fs.ftruncateSync(descriptor, 0);
        fs.writeSync(descriptor, text, 0);
      },
      release: () => {
        if (!open) return;
        open = false;
        fs.closeSync(descriptor);
      },
    },
  };
};

const probeFile = (lockPath: string): boolean => {
  const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW } = fs.constants;
  let descriptor: number;
  try {
    descriptor = fs.openSync(lockPath, O_RDONLY | O_SHLOCK | O_NONBLOCK | O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === WOULD_BLOCK) return true;
    if (code === 'ENOENT') return false;
    throw error;
  }
  fs.closeSync(descriptor);
  return false;
};

export const darwinFileLock: KernelLockMechanism = {
  name: 'file-lock',
  claim: async (lockPath) => claimFile(lockPath),
  isHeld: async (lockPath) => probeFile(lockPath),
  claimInheritable: claimFile,
};

export const ABSTRACT_SOCKET_PREFIX = '\0momonga-lock-';
export const PIPE_LOCK_PREFIX = '\\\\.\\pipe\\momonga-lock-';
const KEY_HEX_CHARS = 32;

const keyOf = (lockPath: string): string => createHash('sha256').update(comparablePath(lockPath)).digest('hex').slice(0, KEY_HEX_CHARS);

const userScope = (user: string): string => createHash('sha256').update(user).digest('hex').slice(0, 8);

export const netLockAddress = (platform: 'linux' | 'win32', lockPath: string, user: string): string =>
  `${platform === 'linux' ? ABSTRACT_SOCKET_PREFIX : PIPE_LOCK_PREFIX}${userScope(user)}-${keyOf(lockPath)}`;

const heldServers = new Set<net.Server>();

export const claimNetAddress = (address: string, holderFile: string): Promise<ClaimOutcome> =>
  new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === 'EADDRINUSE') resolve({ kind: 'held' });
      else reject(error);
    };
    server.once('error', onError);
    server.listen(address, () => {
      server.off('error', onError);
      server.unref();
      heldServers.add(server);
      let open = true;
      resolve({
        kind: 'claimed',
        lock: {
          descriptor: undefined,
          writeHolder: (text) => {
            const descriptor = fs.openSync(holderFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollowFlag(), 0o600);
            try {
              fs.writeSync(descriptor, text);
            } finally {
              fs.closeSync(descriptor);
            }
          },
          release: () => {
            if (!open) return;
            open = false;
            heldServers.delete(server);
            server.close();
          },
        },
      });
    });
  });

export const probeNetAddress = (address: string): Promise<boolean> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(address);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false);
      else if (error.code === WOULD_BLOCK) resolve(true);
      else reject(error);
    });
  });

const netLock = (name: 'abstract-socket' | 'named-pipe', platform: 'linux' | 'win32', user: () => string): KernelLockMechanism => ({
  name,
  claim: (lockPath) => claimNetAddress(netLockAddress(platform, lockPath, user()), lockPath),
  isHeld: (lockPath) => probeNetAddress(netLockAddress(platform, lockPath, user())),
  claimInheritable: undefined,
});

export const createKernelLockMechanism = (platform: NodeJS.Platform, user: () => string = () => os.userInfo().username): KernelLockMechanism => {
  switch (platform) {
    case 'darwin':
      return darwinFileLock;
    case 'linux':
      return netLock('abstract-socket', 'linux', user);
    case 'win32':
      return netLock('named-pipe', 'win32', user);
    default:
      throw new UnsupportedPlatformError(platform, 'process locks');
  }
};

export const hostKernelLock = (): KernelLockMechanism => createKernelLockMechanism(process.platform);
