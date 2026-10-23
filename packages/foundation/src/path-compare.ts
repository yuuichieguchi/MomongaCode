import fs from 'node:fs';
import path from 'node:path';
import { isTransientErrno } from './transient-errno.ts';

const MAX_SYMLINK_HOPS = 40;

export type CaseSensitivityProbe = (existingDirectory: string) => boolean | undefined;

const PLATFORM_DEFAULT_CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

const flipCase = (value: string): string =>
  [...value].map((char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase())).join('');

const hasLetter = (value: string): boolean => value.toLowerCase() !== value.toUpperCase();

const statIfPresent = (target: string): fs.Stats | undefined => {
  try {
    return fs.statSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'ELOOP') return undefined;
    throw error;
  }
};

const compareEntryWithFlippedCase = (entry: string, device: number): boolean | undefined => {
  const original = statIfPresent(entry);
  if (original === undefined || original.dev !== device) return undefined;
  const flipped = path.join(path.dirname(entry), flipCase(path.basename(entry)));
  const variant = statIfPresent(flipped);
  if (variant === undefined) return false;
  return variant.dev === original.dev && variant.ino === original.ino;
};

const probeCaseFolding = (directory: string): boolean | undefined => {
  const device = fs.statSync(directory).dev;
  let current = directory;
  while (current !== path.dirname(current)) {
    const parent = path.dirname(current);
    if (hasLetter(path.basename(current)) && statIfPresent(parent)?.dev === device) {
      const verdict = compareEntryWithFlippedCase(current, device);
      if (verdict !== undefined) return verdict;
    }
    current = parent;
  }
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EACCES') return undefined;
    throw error;
  }
  for (const name of names) {
    if (!hasLetter(name)) continue;
    const verdict = compareEntryWithFlippedCase(path.join(directory, name), device);
    if (verdict !== undefined) return verdict;
  }
  return undefined;
};

let caseSensitivityProbe: CaseSensitivityProbe = probeCaseFolding;
type VolumeVerdict = { rootPath: string; rootIno: number; verdict: boolean };

const caseFoldingByDevice = new Map<number, VolumeVerdict>();

export const setCaseSensitivityProbe = (probe: CaseSensitivityProbe | undefined): void => {
  caseSensitivityProbe = probe ?? probeCaseFolding;
  caseFoldingByDevice.clear();
};

const deepestExistingDirectory = (target: string): { directory: string; device: number } => {
  let current = target;
  for (;;) {
    const stat = statIfPresent(current);
    if (stat?.isDirectory()) return { directory: current, device: stat.dev };
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`no existing directory found for ${target}`);
    current = parent;
  }
};

const mountRootOf = (directory: string, device: number): string => {
  let mountRoot = directory;
  for (;;) {
    const parent = path.dirname(mountRoot);
    if (parent === mountRoot || statIfPresent(parent)?.dev !== device) return mountRoot;
    mountRoot = parent;
  }
};

const verdictForDirectory = (directory: string, device: number): boolean => {
  const cached = caseFoldingByDevice.get(device);
  if (cached !== undefined) {
    const root = statIfPresent(cached.rootPath);
    if (root !== undefined && root.dev === device && root.ino === cached.rootIno) return cached.verdict;
  }
  const rootPath = mountRootOf(directory, device);
  const rootIno = statIfPresent(rootPath)?.ino as number;
  const verdict = caseSensitivityProbe(directory) ?? PLATFORM_DEFAULT_CASE_INSENSITIVE;
  caseFoldingByDevice.set(device, { rootPath, rootIno, verdict });
  return verdict;
};

export const volumeIsCaseInsensitive = (target: string): boolean => {
  const { directory, device } = deepestExistingDirectory(target);
  return verdictForDirectory(directory, device);
};

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


export type CanonicalDirectoryFailureCode = 'not_absolute' | 'unresolvable' | 'missing' | 'not_directory' | 'unreadable';

export type CanonicalDirectoryResult =
  | { ok: true; path: string }
  | { ok: false; code: CanonicalDirectoryFailureCode; reason: string };

const UNRESOLVABLE_ERRNO = new Set(['ENOTDIR', 'ELOOP', 'ENAMETOOLONG']);

export const canonicalDirectory = (input: string): CanonicalDirectoryResult => {
  if (!path.isAbsolute(input)) return { ok: false, code: 'not_absolute', reason: 'must be an absolute path' };
  let canonical: string;
  try {
    canonical = canonicalPath(input);
  } catch (error) {
    if (isTransientErrno(error)) throw error;
    return { ok: false, code: 'unresolvable', reason: `cannot be resolved: ${(error as Error).message}` };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(canonical);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (isTransientErrno(error)) throw error;
    if (code === 'ENOENT') return { ok: false, code: 'missing', reason: 'does not exist' };
    if (code !== undefined && UNRESOLVABLE_ERRNO.has(code)) {
      return { ok: false, code: 'unresolvable', reason: `cannot be resolved: ${(error as Error).message}` };
    }
    return { ok: false, code: 'unreadable', reason: 'cannot be read' };
  }
  if (!stat.isDirectory()) return { ok: false, code: 'not_directory', reason: 'is not a directory' };
  try {
    fs.accessSync(canonical, fs.constants.R_OK | fs.constants.X_OK);
  } catch (error) {
    if (isTransientErrno(error)) throw error;
    return { ok: false, code: 'unreadable', reason: 'cannot be read' };
  }
  return { ok: true, path: canonical };
};

export type PathParts = { existing: string; tail: readonly string[] };

const componentsOfPath = (value: string): string[] => value.split('/').filter((component) => component !== '');

export const containsByComponents = (base: PathParts, candidate: PathParts, foldTail: boolean): boolean => {
  const baseExisting = componentsOfPath(base.existing);
  const candidateExisting = componentsOfPath(candidate.existing);
  const baseAll = [...baseExisting, ...base.tail];
  const candidateAll = [...candidateExisting, ...candidate.tail];
  if (baseAll.length > candidateAll.length) return false;
  const exactCount = Math.min(baseExisting.length, candidateExisting.length);
  return baseAll.every((component, index) => {
    const other = candidateAll[index] as string;
    if (index < exactCount) return component === other;
    return foldTail ? component.toLowerCase() === other.toLowerCase() : component === other;
  });
};

type LocatedParts = { parts: PathParts; caseInsensitive: boolean };

const locate = (value: string): LocatedParts => {
  if (!path.isAbsolute(value)) throw new Error(`path must be absolute: ${value}`);
  let resolved: string | undefined;
  try {
    resolved = canonicalPath(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EACCES') throw error;
  }
  const { directory, device } = deepestExistingDirectory(resolved ?? value);
  const existing = resolved === undefined ? fs.realpathSync.native(directory) : directory;
  return {
    parts: { existing, tail: componentsOfPath(path.relative(directory, resolved ?? value)) },
    caseInsensitive: verdictForDirectory(directory, device),
  };
};

export const comparableFromParts = (parts: PathParts, foldTail: boolean): string =>
  path.join(parts.existing, ...(foldTail ? parts.tail.map((component) => component.toLowerCase()) : parts.tail));

export const comparablePath = (input: string): string => {
  const { parts, caseInsensitive } = locate(input);
  return comparableFromParts(parts, caseInsensitive);
};

export const comparableContains = (directory: string, candidate: string): boolean => {
  const located = locate(candidate);
  return containsByComponents(locate(directory).parts, located.parts, located.caseInsensitive);
};
