import path from 'node:path';
import { resolveCanonicalPath } from './path-resolution.ts';

export const resolveToolPath = (workingDirectory: string, value: string): string => path.resolve(workingDirectory, value);

const canonicalOrWritten = (absolute: string): string => {
  const resolution = resolveCanonicalPath(absolute);
  return resolution.ok ? resolution.path : absolute;
};

const canonicalParentForm = (absolute: string): string => {
  const parent = resolveCanonicalPath(path.dirname(absolute));
  return parent.ok ? path.join(parent.path, path.basename(absolute)) : absolute;
};

const relativeWithin = (base: string, target: string): string | undefined => {
  const relative = path.relative(base, target);
  if (relative === '') return '.';
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return relative;
};

export const displayToolPath = (workingDirectory: string, absolute: string): string => {
  const bases = [workingDirectory, canonicalOrWritten(workingDirectory)];
  for (const target of [absolute, canonicalParentForm(absolute)]) {
    for (const base of bases) {
      const relative = relativeWithin(base, target);
      if (relative !== undefined) return relative;
    }
  }
  return absolute;
};
