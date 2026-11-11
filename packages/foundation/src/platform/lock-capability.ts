import path from 'node:path';
import { OPEN_FLAGS, nodeFileSystemSync } from '../node-file-system.ts';
import type { DirectoryIdentity, FileSystemSync } from '../node-file-system.ts';
import type { Random } from '../random.ts';
import { systemRandom } from '../system-random.ts';
import { nodeFileLockOps, resolveKernelLock } from './kernel-lock.ts';
import type { FileLockOps, KernelLockMechanism } from './kernel-lock.ts';

export type LockCapability = 'proved' | 'unenforced' | 'unmeasured';

export interface LockCapabilityProbe {
  of(dir: string): Promise<LockCapability>;
  decide(dir: string): LockDecision;
  contradicted(dir: string): void;
}

export type { DirectoryIdentity };

export type ProofDirectoryFiles = Pick<FileSystemSync, 'lstatSync'>;

export type LockCapabilityOptions = {
  proofDir: string;
  ops?: FileLockOps;
  statDirectory?: (dir: string) => DirectoryIdentity;
  random?: Random;
  files?: ProofDirectoryFiles;
  uid?: () => number | undefined;
};

export const UNMEASURED_CAPABILITY: LockCapabilityProbe = {
  of: async () => 'unmeasured',
  decide: () => 'unprovable',
  contradicted: () => undefined,
};

export const O_SHLOCK = 0x10;
export const O_EXLOCK = 0x20;

const WOULD_BLOCK = 'EAGAIN';
const NOT_ENFORCED_CODES = ['ENOTSUP', 'EOPNOTSUPP', 'EINVAL'];
const PROOF_MODE = 0o600;

const sharedProbeFlags = (): number => OPEN_FLAGS.readOnly | O_SHLOCK | OPEN_FLAGS.nonBlocking;
const createLockedFlags = (access: number): number => access | OPEN_FLAGS.create | OPEN_FLAGS.exclusive | O_EXLOCK | OPEN_FLAGS.nonBlocking;

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

const STAGING_SUFFIX_BYTES = 6;

const stagingPathOf = (file: string, random: Random): string => {
  const dir = path.dirname(file);
  return path.join(path.dirname(dir), `.${path.basename(dir)}.${path.basename(file)}.${random.hex(STAGING_SUFFIX_BYTES)}.creating`);
};

export class StagingLinkError extends Error {
  readonly stagingPath: string;
  readonly targetPath: string;
  constructor(stagingPath: string, targetPath: string, options: { cause: unknown }) {
    super(`${stagingPath} cannot be hard-linked to ${targetPath}: the two paths are on different filesystems, so the locked file cannot be given its name without a moment in which it exists unlocked`, options);
    this.name = 'StagingLinkError';
    this.stagingPath = stagingPath;
    this.targetPath = targetPath;
  }
}

export type StagingFiles = { linkSync(from: string, to: string): void; rmSync(file: string): void };

const linkStaged = (files: StagingFiles, staged: string, file: string): void => {
  try {
    files.linkSync(staged, file);
  } catch (error) {
    if (codeOf(error) === 'EXDEV') throw new StagingLinkError(staged, file, { cause: error });
    throw error;
  }
};

export const createLockedFile = (
  ops: FileLockOps,
  file: string,
  access: number,
  mode: number,
  initialize: (staged: string) => void = () => undefined,
  files: StagingFiles = nodeFileSystemSync,
  random: Random = systemRandom,
): number => {
  const staged = stagingPathOf(file, random);
  const descriptor = ops.open(staged, createLockedFlags(access), mode);
  let linked = false;
  try {
    initialize(staged);
    linkStaged(files, staged, file);
    linked = true;
    files.rmSync(staged);
  } catch (error) {
    ops.close(descriptor);
    files.rmSync(staged);
    if (linked) files.rmSync(file);
    throw error;
  }
  return descriptor;
};

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

type Proof = { kind: 'proved' } | { kind: 'unenforced' } | { kind: 'failed'; cause: unknown };

const openFailure = (error: unknown): Proof => (NOT_ENFORCED_CODES.includes(codeOf(error) ?? '') ? { kind: 'unenforced' } : { kind: 'failed', cause: error });

const prove = (ops: FileLockOps, random: Random, proofDir: string): Proof => {
  const file = path.join(proofDir, random.uuid());
  let creator: number | undefined;
  try {
    try {
      creator = createLockedFile(ops, file, OPEN_FLAGS.readOnly, PROOF_MODE);
    } catch (error) {
      return openFailure(error);
    }
    let refused: boolean;
    try {
      refused = sharedOpenIsRefused(ops, file);
    } catch (error) {
      return openFailure(error);
    }
    if (!refused) return { kind: 'unenforced' };
    ops.close(creator);
    creator = undefined;
    if (sharedOpenIsRefused(ops, file)) return { kind: 'failed', cause: new Error(`${file} still refuses a shared lock after its only holder closed it`) };
    removeFreeLeftovers(ops, proofDir, file);
    return { kind: 'proved' };
  } catch (error) {
    return { kind: 'failed', cause: error };
  } finally {
    if (creator !== undefined) ops.close(creator);
    nodeFileSystemSync.rmSync(file);
  }
};

type Enforcement = 'proved' | 'unenforced';

type Cached = { identity: DirectoryIdentity; result: Enforcement };

type Measurement = { kind: Enforcement } | { kind: 'unprovable' } | { kind: 'failed'; cause: unknown };

export type LockDecision = Enforcement | 'unprovable';

export class LockProofFailedError extends Error {
  readonly directory: string;
  constructor(directory: string, proofDir: string, cause: unknown) {
    super(`Whether ${directory} enforces file locks could not be measured in ${proofDir}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'LockProofFailedError';
    this.directory = directory;
  }
}

const OTHER_ACCOUNTS_MODE = 0o077;

const hostUid = (): number | undefined => process.getuid?.();

const proofDirectoryIsPrivate = (files: ProofDirectoryFiles, proofDir: string, uid: number | undefined): boolean => {
  const stat = files.lstatSync(proofDir);
  const foreign = uid !== undefined && stat.uid !== uid;
  return stat.isDirectory() && !stat.isSymbolicLink() && !foreign && (stat.mode & OTHER_ACCOUNTS_MODE) === 0;
};

export const createLockCapability = ({
  proofDir,
  ops = nodeFileLockOps,
  statDirectory = statIdentity,
  random = systemRandom,
  files = nodeFileSystemSync,
  uid = hostUid,
}: LockCapabilityOptions): LockCapabilityProbe => {
  const cache = new Map<string, Cached>();
  const inflight = new Map<string, Promise<Measurement>>();

  const proofDirectoryMeasures = (identity: DirectoryIdentity): boolean => proofDirectoryIsPrivate(files, proofDir, uid()) && statDirectory(proofDir).dev === identity.dev;

  const measure = (dir: string, identity: DirectoryIdentity): Measurement => {
    let usable: boolean;
    try {
      usable = proofDirectoryMeasures(identity);
    } catch (error) {
      return { kind: 'failed', cause: error };
    }
    if (!usable) return { kind: 'unprovable' };
    const proof = prove(ops, random, proofDir);
    if (proof.kind !== 'failed') cache.set(dir, { identity, result: proof.kind });
    return proof;
  };

  const resolve = (dir: string): Measurement => {
    let identity: DirectoryIdentity;
    try {
      identity = statDirectory(dir);
    } catch (error) {
      cache.delete(dir);
      return { kind: 'failed', cause: error };
    }
    const cached = cache.get(dir);
    if (cached !== undefined) {
      if (cached.identity.dev === identity.dev && cached.identity.ino === identity.ino) return { kind: cached.result };
      cache.delete(dir);
    }
    return measure(dir, identity);
  };

  const measured = (dir: string): Promise<Measurement> => {
    const running = inflight.get(dir);
    if (running !== undefined) return running;
    const started = Promise.resolve().then(() => resolve(dir));
    inflight.set(dir, started);
    const clear = (): void => void inflight.delete(dir);
    started.then(clear, clear);
    return started;
  };

  const decisionOf = (dir: string, measurement: Measurement): LockDecision => {
    if (measurement.kind === 'failed') throw new LockProofFailedError(dir, proofDir, measurement.cause);
    return measurement.kind;
  };

  return {
    of: async (dir) => {
      const measurement = await measured(dir);
      return measurement.kind === 'proved' || measurement.kind === 'unenforced' ? measurement.kind : 'unmeasured';
    },
    decide: (dir) => decisionOf(dir, resolve(dir)),
    contradicted: (dir) => void cache.delete(dir),
  };
};

export type LayoutLocks = { capability: LockCapabilityProbe; mechanism: KernelLockMechanism };

export const resolveLayoutLocks = (paths: { callLocks: string; lockProof: string }): LayoutLocks => {
  const capability = createLockCapability({ proofDir: paths.lockProof });
  return { capability, mechanism: resolveKernelLock(paths.callLocks, { capability }) };
};
