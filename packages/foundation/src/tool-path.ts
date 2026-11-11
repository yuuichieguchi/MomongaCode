import path from 'node:path';
import type { PathResolver } from './path-compare.ts';
import type { PathResolution } from './path-resolution.ts';

type Resolving = Pick<PathResolver, 'resolveCanonicalPath'>;

export const resolveToolPath = (workingDirectory: string, value: string): string => path.resolve(workingDirectory, value);

export const canonicalOrWritten = (absolute: string, resolution: PathResolution): string => (resolution.ok ? resolution.path : absolute);

export const parentFormOf = (absolute: string, parent: PathResolution): string => (parent.ok ? path.join(parent.path, path.basename(absolute)) : absolute);

const relativeWithin = (base: string, target: string): string | undefined => {
  const relative = path.relative(base, target);
  if (relative === '') return '.';
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return relative;
};

export const displayAmong = (bases: readonly string[], targets: readonly string[], absolute: string): string => {
  for (const target of targets) {
    for (const base of bases) {
      const relative = relativeWithin(base, target);
      if (relative !== undefined) return relative;
    }
  }
  return absolute;
};

export const displayToolPath = async (workingDirectory: string, absolute: string, paths: Resolving): Promise<string> => {
  const bases = [workingDirectory, canonicalOrWritten(workingDirectory, await paths.resolveCanonicalPath(workingDirectory))];
  return displayAmong(bases, [absolute, parentFormOf(absolute, await paths.resolveCanonicalPath(path.dirname(absolute)))], absolute);
};
