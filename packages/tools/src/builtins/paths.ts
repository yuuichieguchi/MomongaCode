import path from 'node:path';
import { comparableContains, displayToolPath, resolveCanonicalPath, resolveToolPath } from '@momonga/foundation';
import { ToolInputError } from '../types.ts';
import type { SubjectContext } from '../types.ts';

export type PathScope = Pick<SubjectContext, 'workingDirectory'>;

export const resolvedPathOf = (scope: PathScope, value: string): string => resolveToolPath(scope.workingDirectory, value);

export const accessedPathOf = (scope: PathScope, value: string): string => {
  const absolute = resolvedPathOf(scope, value);
  const resolution = resolveCanonicalPath(absolute);
  return resolution.ok ? resolution.path : absolute;
};

export const shownPath = (scope: PathScope, absolute: string): string => displayToolPath(scope.workingDirectory, absolute);

export const canonicalPathOf = (scope: PathScope, field: string, value: string): string => {
  const absolute = resolvedPathOf(scope, value);
  const resolution = resolveCanonicalPath(absolute);
  if (!resolution.ok) throw new ToolInputError(`${field} cannot be resolved to a real location: ${shownPath(scope, absolute)}`);
  return resolution.path;
};

export const insideAny = (candidate: string, directories: readonly string[]): boolean =>
  directories.some((directory) => comparableContains(directory, candidate));

export const canonicalDirectories = (directories: readonly string[]): string[] =>
  directories.map((directory) => {
    const resolution = resolveCanonicalPath(directory);
    return resolution.ok ? resolution.path : path.resolve(directory);
  });
