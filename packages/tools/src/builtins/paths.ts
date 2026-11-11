import path from 'node:path';
import { displayToolPath, mapAsync, resolveToolPath, someAsync } from '@momonga/foundation';
import type { PathResolver } from '@momonga/foundation';
import { ToolInputError } from '../types.ts';
import type { SubjectContext } from '../types.ts';

export type PathScope = Pick<SubjectContext, 'workingDirectory' | 'paths'>;

export const resolvedPathOf = (scope: Pick<PathScope, 'workingDirectory'>, value: string): string => resolveToolPath(scope.workingDirectory, value);

export const accessedPathOf = async (scope: PathScope, value: string): Promise<string> => {
  const absolute = resolvedPathOf(scope, value);
  const resolution = await scope.paths.resolveCanonicalPath(absolute);
  return resolution.ok ? resolution.path : absolute;
};

export const shownPath = (scope: PathScope, absolute: string): Promise<string> => displayToolPath(scope.workingDirectory, absolute, scope.paths);

export const canonicalPathOf = async (scope: PathScope, field: string, value: string): Promise<string> => {
  const absolute = resolvedPathOf(scope, value);
  const resolution = await scope.paths.resolveCanonicalPath(absolute);
  if (!resolution.ok) throw new ToolInputError(`${field} cannot be resolved to a real location: ${await shownPath(scope, absolute)}`);
  return resolution.path;
};

export const insideAny = (candidate: string, directories: readonly string[], paths: Pick<PathResolver, 'comparableContains'>): Promise<boolean> =>
  someAsync(directories, (directory) => paths.comparableContains(directory, candidate));

export const canonicalDirectories = (directories: readonly string[], paths: Pick<PathResolver, 'resolveCanonicalPath'>): Promise<string[]> =>
  mapAsync(directories, async (directory) => {
    const resolution = await paths.resolveCanonicalPath(directory);
    return resolution.ok ? resolution.path : path.resolve(directory);
  });
