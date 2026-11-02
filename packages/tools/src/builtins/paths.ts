import path from 'node:path';
import { comparableContains, resolveCanonicalPath } from '@momonga/foundation';
import { ToolInputError } from '../types.ts';

export const requireAbsolute = (field: string, value: string): string => {
  if (!path.isAbsolute(value)) throw new ToolInputError(`${field} must be an absolute path`);
  return value;
};

export const canonicalPathOf = (field: string, value: string): string => {
  const resolution = resolveCanonicalPath(requireAbsolute(field, value));
  if (!resolution.ok) throw new ToolInputError(`${field} cannot be resolved to a real location: ${value}`);
  return resolution.path;
};

export const insideAny = (candidate: string, directories: readonly string[]): boolean =>
  directories.some((directory) => comparableContains(directory, candidate));

export const canonicalDirectories = (directories: readonly string[]): string[] =>
  directories.map((directory) => {
    const resolution = resolveCanonicalPath(directory);
    return resolution.ok ? resolution.path : path.resolve(directory);
  });
