import fs from 'node:fs';
import path from 'node:path';

const MAX_SYMLINK_HOPS = 40;

export const volumeIsCaseInsensitive = process.platform === 'darwin' || process.platform === 'win32';

export const foldCase = (value: string): string => (volumeIsCaseInsensitive ? value.toLowerCase() : value);

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

export const canonicalPath = (input: string): string => {
  if (!path.isAbsolute(input)) throw new Error(`path must be absolute: ${input}`);
  const missing: string[] = [];
  let current = input;
  let hops = MAX_SYMLINK_HOPS;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing.reverse());
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (stat?.isSymbolicLink() === true) {
      hops -= 1;
      if (hops < 0) throw new Error(`too many symbolic links resolving ${input}`);
      current = path.resolve(fs.realpathSync.native(path.dirname(current)), fs.readlinkSync(current));
      continue;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.join(current, ...missing.reverse());
    missing.push(path.basename(current));
    current = parent;
  }
};

export const comparablePath = (input: string): string => foldCase(canonicalPath(input));

export const comparableContains = (directory: string, candidate: string): boolean => {
  const base = foldCase(directory);
  const target = foldCase(candidate);
  return target === base || target.startsWith(base === path.sep ? base : base + path.sep);
};
