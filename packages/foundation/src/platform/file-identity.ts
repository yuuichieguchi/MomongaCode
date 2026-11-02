import fs from 'node:fs';

export type LockFileIdentity = { dev: bigint; ino: bigint };

export const identityOfStats = (stats: fs.BigIntStats): LockFileIdentity => ({ dev: stats.dev, ino: stats.ino });

export const sameFile = (left: LockFileIdentity | undefined, right: LockFileIdentity | undefined): boolean =>
  left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;

export const lstatIdentity = (target: string): LockFileIdentity | undefined => {
  let stats: fs.BigIntStats;
  try {
    stats = fs.lstatSync(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!stats.isFile()) throw new Error(`${target} is not a regular file`);
  return identityOfStats(stats);
};

export const fstatIdentity = (descriptor: number): LockFileIdentity => identityOfStats(fs.fstatSync(descriptor, { bigint: true }));
