import path from 'node:path';
import { comparableContains } from '@momonga/foundation';
import { canonicalizePath } from '@momonga/policy';
import { ToolInputError } from '../types.ts';

export const requireAbsolute = (field: string, value: string): string => {
  if (!path.isAbsolute(value)) throw new ToolInputError(`${field} must be an absolute path`);
  return value;
};

export const canonicalPathOf = (field: string, value: string): string => {
  const canonical = canonicalizePath(requireAbsolute(field, value));
  if (canonical === null) throw new ToolInputError(`${field} cannot be resolved to a real location: ${value}`);
  return canonical;
};

export const insideAny = (candidate: string, directories: readonly string[]): boolean =>
  directories.some((directory) => comparableContains(directory, candidate));

export const canonicalDirectories = (directories: readonly string[]): string[] =>
  directories.map((directory) => canonicalizePath(directory) ?? path.resolve(directory));
