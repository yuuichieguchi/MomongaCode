import os from 'node:os';
import path from 'node:path';
import { OPEN_FLAGS, nodeFileSystemSync } from '../node-file-system.ts';
import type { DirectoryIdentity } from '../node-file-system.ts';
import type { Random } from '../random.ts';
import { systemRandom } from '../system-random.ts';
import { nodeFileLockOps } from './kernel-lock.ts';
import type { FileLockOps } from './kernel-lock.ts';

export type LockCapability = 'proved' | 'unenforced' | 'unmeasured';

export interface LockCapabilityProbe {
  of(dir: string): Promise<LockCapability>;
  contradicted(dir: string): void;
}

export type { DirectoryIdentity };

export type LockCapabilityOptions = {
  proofDir: string;
  ops?: FileLockOps;
  statDirectory?: (dir: string) => DirectoryIdentity;
  random?: Random;
};

export const UNMEASURED_CAPABILITY: LockCapabilityProbe = {
  of: async () => 'unmeasured',
  contradicted: () => undefined,
};

export const O_SHLOCK = 0x10;
export const O_EXLOCK = 0x20;

const WOULD_BLOCK = 'EAGAIN';
const NOT_ENFORCED_CODES = ['ENOTSUP', 'EOPNOTSUPP', 'EINVAL'];
const PROOF_MODE = 0o600;

const sharedProbeFlags = (): number => OPEN_FLAGS.readOnly | O_SHLOCK | OPEN_FLAGS.nonBlocking;
const createLockedFlags = (): number => OPEN_FLAGS.readOnly | OPEN_FLAGS.create | OPEN_FLAGS.exclusive | O_EXLOCK | OPEN_FLAGS.nonBlocking;

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

const statIdentity = (dir: string): DirectoryIdentity => nodeFileSystemSync.identitySync(dir);

const sharedOpenIsRefused = (ops: FileLockOps, file: string): boolean => {
  let descriptor: number;
  try {
    descriptor = ops.open(file, sharedProbeFlags());
  } catch (error) {
    if (codeOf(error) === WOULD_BLOCK) return true;
    throw error;
  }
  ops.close(descriptor);
  return false;
};

const removeFreeLeftovers = (ops: FileLockOps, proofDir: string, own: string): void => {
  for (const name of nodeFileSystemSync.readdirSync(proofDir)) {
    const file = path.join(proofDir, name);
    if (file === own) continue;
    try {
      if (!sharedOpenIsRefused(ops, file)) nodeFileSystemSync.rmSync(file);
    } catch {
      continue;
    }
  }
};

const prove = (ops: FileLockOps, random: Random, proofDir: string): 'proved' | 'unenforced' | 'unmeasured' => {
  const file = path.join(proofDir, random.uuid());
  let creator: number | undefined;
  try {
    try {
      creator = ops.open(file, createLockedFlags(), PROOF_MODE);
    } catch (error) {
      return NOT_ENFORCED_CODES.includes(codeOf(error) ?? '') ? 'unenforced' : 'unmeasured';
    }
    let refused: boolean;
    try {
      refused = sharedOpenIsRefused(ops, file);
    } catch (error) {
      return NOT_ENFORCED_CODES.includes(codeOf(error) ?? '') ? 'unenforced' : 'unmeasured';
    }
    if (!refused) return 'unenforced';
    ops.close(creator);
    creator = undefined;
    try {
      if (sharedOpenIsRefused(ops, file)) return 'unmeasured';
    } catch {
      return 'unmeasured';
    }
    removeFreeLeftovers(ops, proofDir, file);
    return 'proved';
  } catch {
    return 'unmeasured';
  } finally {
    if (creator !== undefined) ops.close(creator);
    nodeFileSystemSync.rmSync(file);
  }
};

type Cached = { identity: DirectoryIdentity; result: 'proved' | 'unenforced' };

export const createLockCapability = ({ proofDir, ops = nodeFileLockOps, statDirectory = statIdentity, random = systemRandom }: LockCapabilityOptions): LockCapabilityProbe => {
  const cache = new Map<string, Cached>();
  const inflight = new Map<string, Promise<LockCapability>>();

  const measure = (dir: string, identity: DirectoryIdentity): LockCapability => {
    const proof = statDirectory(proofDir);
    if (proof.dev !== identity.dev) return 'unmeasured';
    const result = prove(ops, random, proofDir);
    if (result !== 'unmeasured') cache.set(dir, { identity, result });
    return result;
  };

  const resolve = (dir: string): LockCapability => {
    let identity: DirectoryIdentity;
    try {
      identity = statDirectory(dir);
    } catch {
      cache.delete(dir);
      return 'unmeasured';
    }
    const cached = cache.get(dir);
    if (cached !== undefined) {
      if (cached.identity.dev === identity.dev && cached.identity.ino === identity.ino) return cached.result;
      cache.delete(dir);
    }
    return measure(dir, identity);
  };

  return {
    of: (dir) => {
      const running = inflight.get(dir);
      if (running !== undefined) return running;
      const started = Promise.resolve().then(() => resolve(dir));
      inflight.set(dir, started);
      const clear = (): void => void inflight.delete(dir);
      started.then(clear, clear);
      return started;
    },
    contradicted: (dir) => void cache.delete(dir),
  };
};

const privateProofDirectory = (): string | undefined => {
  const uid = process.getuid?.();
  const directory = path.join(os.tmpdir(), `momonga-lock-proof-${uid ?? 'user'}`);
  try {
    nodeFileSystemSync.mkdirSync(directory, 0o700);
  } catch (error) {
    if (codeOf(error) !== 'EEXIST') return undefined;
  }
  const stat = nodeFileSystemSync.lstatSync(directory);
  const foreign = uid !== undefined && stat.uid !== uid;
  return stat.isDirectory() && !stat.isSymbolicLink() && !foreign && (stat.mode & 0o077) === 0 ? directory : undefined;
};

let hosted: LockCapabilityProbe | undefined;

export const hostLockCapability: LockCapabilityProbe = {
  of: async (dir) => {
    if (hosted === undefined) {
      const proofDir = privateProofDirectory();
      if (proofDir === undefined) return 'unmeasured';
      hosted = createLockCapability({ proofDir });
    }
    return hosted.of(dir);
  },
  contradicted: (dir) => hosted?.contradicted(dir),
};
