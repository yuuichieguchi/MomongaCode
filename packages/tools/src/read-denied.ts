import path from 'node:path';
import { absoluteFrom, canonicalizePath, isInside, volumeIsCaseInsensitive } from '@momonga/policy';

const comparable = (value: string): string => (volumeIsCaseInsensitive ? value.toLowerCase() : value);

export const createReadDeniedMatcher = (readDenied: readonly string[], cwd: string) => {
  const guards = readDenied.map((entry) => comparable(canonicalizePath(absoluteFrom(entry, cwd)) ?? path.resolve(cwd, entry)));
  const blocksResolved = (resolved: string): boolean => {
    const candidate = comparable(resolved);
    return guards.some((guard) => isInside(candidate, guard));
  };
  return {
    blocksResolved,
    blocks: (target: string): boolean =>
      blocksResolved(canonicalizePath(absoluteFrom(target, cwd)) ?? path.resolve(cwd, target)) || blocksResolved(path.resolve(cwd, target)),
  };
};
