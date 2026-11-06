import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nodeFileLockOps } from './kernel-lock.ts';
import type { FileLockOps } from './kernel-lock.ts';

export type LockCapability = 'proved' | 'unenforced' | 'unmeasured';

export interface LockCapabilityProbe {
  of(dir: string): Promise<LockCapability>;
  contradicted(dir: string): void;
}

export type DirectoryIdentity = { dev: bigint; ino: bigint };

export type LockCapabilityOptions = {
  proofDir: string;
  ops?: FileLockOps;
  statDirectory?: (dir: string) => DirectoryIdentity;
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

const sharedProbeFlags = (): number => fs.constants.O_RDONLY | O_SHLOCK | fs.constants.O_NONBLOCK;
const createLockedFlags = (): number => fs.constants.O_RDONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_EXLOCK | fs.constants.O_NONBLOCK;

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

const statIdentity = (dir: string): DirectoryIdentity => {
  const stat = fs.statSync(dir, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
};

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
  for (const name of fs.readdirSync(proofDir)) {
    const file = path.join(proofDir, name);
    if (file === own) continue;
    try {
      if (!sharedOpenIsRefused(ops, file)) fs.rmSync(file, { force: true });
    } catch {
      continue;
    }
  }
};

const prove = (ops: FileLockOps, proofDir: string): 'proved' | 'unenforced' | 'unmeasured' => {
  const file = path.join(proofDir, randomUUID());
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
    fs.rmSync(file, { force: true });
  }
};

type Cached = { identity: DirectoryIdentity; result: 'proved' | 'unenforced' };

export const createLockCapability = ({ proofDir, ops = nodeFileLockOps, statDirectory = statIdentity }: LockCapabilityOptions): LockCapabilityProbe => {
  const cache = new Map<string, Cached>();
  const inflight = new Map<string, Promise<LockCapability>>();

  const measure = (dir: string, identity: DirectoryIdentity): LockCapability => {
    const proof = statDirectory(proofDir);
    if (proof.dev !== identity.dev) return 'unmeasured';
    const result = prove(ops, proofDir);
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
