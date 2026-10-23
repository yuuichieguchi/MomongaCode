import fs from 'node:fs';
import path from 'node:path';

const MAX_SYMLINK_HOPS = 40;

export const volumeIsCaseInsensitive = process.platform === 'darwin' || process.platform === 'win32';

export const foldCase = (value: string): string => (volumeIsCaseInsensitive ? value.toLowerCase() : value);

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

const DIRECTORY_REQUIRED = '/';

const componentsOf = (value: string): string[] => {
  const components = value.split('/').filter((component) => component !== '' && component !== '.');
  return value.endsWith('/') ? [...components, DIRECTORY_REQUIRED] : components;
};

export const canonicalPath = (input: string): string => {
  if (!path.isAbsolute(input)) throw new Error(`path must be absolute: ${input}`);
  const pending = componentsOf(input).reverse();
  let prefix: string = path.sep;
  let hops = MAX_SYMLINK_HOPS;
  while (pending.length > 0) {
    const component = pending.pop() as string;
    if (component === DIRECTORY_REQUIRED) continue;
    if (component === '..') {
      prefix = path.dirname(prefix);
      continue;
    }
    const candidate = path.join(prefix, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (!isMissing(error)) throw error;
      const tail = [component, ...pending.reverse()];
      if (tail.includes('..')) throw new Error(`cannot resolve '..' below a missing component: ${input}`);
      if (tail.includes(DIRECTORY_REQUIRED)) throw new Error(`missing component followed by a slash: ${input}`);
      return path.join(fs.realpathSync.native(prefix), ...tail);
    }
    if (stat.isSymbolicLink()) {
      hops -= 1;
      if (hops < 0) throw new Error(`too many symbolic links resolving ${input}`);
      const target = fs.readlinkSync(candidate);
      if (target === '') throw new Error(`empty symbolic link target: ${candidate}`);
      if (path.isAbsolute(target)) prefix = path.sep;
      pending.push(...componentsOf(target).reverse());
      continue;
    }
    if (pending.length > 0 && !stat.isDirectory()) throw new Error(`not a directory: ${candidate}`);
    prefix = candidate;
  }
  return fs.realpathSync.native(prefix);
};

export const comparablePath = (input: string): string => foldCase(canonicalPath(input));

export const comparableContains = (directory: string, candidate: string): boolean => {
  const base = foldCase(directory);
  const target = foldCase(candidate);
  return target === base || target.startsWith(base === path.sep ? base : base + path.sep);
};
