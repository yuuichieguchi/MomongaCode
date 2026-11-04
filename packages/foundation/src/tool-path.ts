import path from 'node:path';
import { resolveCanonicalPath } from './path-resolution.ts';

export const resolveToolPath = (workingDirectory: string, value: string): string => path.resolve(workingDirectory, value);

const canonicalOrLexical = (absolute: string): string => {
  const resolution = resolveCanonicalPath(absolute);
  return resolution.ok ? resolution.path : path.resolve(absolute);
};

export const displayToolPath = (workingDirectory: string, absolute: string): string => {
  const base = canonicalOrLexical(workingDirectory);
  const target = canonicalOrLexical(absolute);
  const relative = path.relative(base, target);
  if (relative === '') return '.';
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return target;
  return relative;
};
