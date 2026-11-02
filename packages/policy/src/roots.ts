import { comparableContains } from '@momonga/foundation';
import type { PathResolution } from '@momonga/foundation';
import { absoluteFrom } from './path-match.ts';

export const insideRoots = (
  paths: readonly string[],
  roots: readonly string[],
  cwd: string,
  canonicalise: (absolute: string) => PathResolution,
): boolean => {
  if (paths.length === 0) return false;
  const canonicalRoots: string[] = [];
  for (const root of roots) {
    const resolution = canonicalise(absoluteFrom(root, cwd));
    if (resolution.ok) canonicalRoots.push(resolution.path);
  }
  return paths.every((target) => {
    const real = canonicalise(absoluteFrom(target, cwd));
    return real.ok && canonicalRoots.some((root) => comparableContains(root, real.path));
  });
};
