import fs from 'node:fs';
import path from 'node:path';

const MAX_SYMLINK_HOPS = 40;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function resolveComponents(absolute: string, hops: { remaining: number }): string {
  let current = path.parse(absolute).root;
  for (const component of absolute.slice(current.length).split(path.sep)) {
    if (component === '' || component === '.') continue;
    if (component === '..') {
      current = path.dirname(current);
      continue;
    }
    const candidate = path.join(current, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (!isMissing(error)) throw error;
      current = candidate;
      continue;
    }
    if (!stat.isSymbolicLink()) {
      current = candidate;
      continue;
    }
    hops.remaining -= 1;
    if (hops.remaining < 0) throw new Error(`too many symbolic links resolving ${absolute}`);
    current = resolveComponents(path.resolve(current, fs.readlinkSync(candidate)), hops);
  }
  return current;
}

export function canonicalizePath(input: string): string {
  if (!path.isAbsolute(input)) throw new Error(`path must be absolute: ${input}`);
  return resolveComponents(input, { remaining: MAX_SYMLINK_HOPS });
}
