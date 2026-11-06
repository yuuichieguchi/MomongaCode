import fs from 'node:fs';
import path from 'node:path';
import type { Unresolved } from './path-resolution.ts';
import { isTransientErrno } from './transient-errno.ts';
import { unmeasuredBecause } from './capability-probe.ts';
import type { CapabilityResult } from './capability-probe.ts';

export type CaseSensitivityProbe = (existingDirectory: string) => boolean | undefined;

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
type VolumeVerdict = { rootPath: string; rootIno: number; result: CapabilityResult<boolean> };

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

const UNDETERMINED = 'case sensitivity of this volume could not be determined';

const measureCaseSensitivity = (directory: string): CapabilityResult<boolean> => {
  let verdict: boolean | undefined;
  try {
    verdict = caseSensitivityProbe(directory);
  } catch (error) {
    const reason = unmeasuredBecause(error).evidence;
    return { kind: 'unmeasured', evidence: `${UNDETERMINED}: ${reason} (${directory})` };
  }
  if (verdict === undefined) {
    return { kind: 'unsupported', evidence: `${UNDETERMINED}: no entry on the volume could be compared in a different case (${directory})` };
  }
  return { kind: 'supported', value: verdict, evidence: `measured on the volume of ${directory}` };
};

const resultForDirectory = (directory: string, device: number): CapabilityResult<boolean> => {
  const cached = caseFoldingByDevice.get(device);
  if (cached !== undefined) {
    const root = statIfPresent(cached.rootPath);
    if (root !== undefined && root.dev === device && root.ino === cached.rootIno) return cached.result;
  }
  const rootPath = mountRootOf(directory, device);
  const rootIno = statIfPresent(rootPath)?.ino as number;
  const result = measureCaseSensitivity(directory);
  if (result.kind === 'unmeasured') caseFoldingByDevice.delete(device);
  else caseFoldingByDevice.set(device, { rootPath, rootIno, result });
  return result;
};

const verdictForDirectory = (directory: string, device: number): boolean => {
  const result = resultForDirectory(directory, device);
  if (result.kind !== 'supported') throw new Error(result.evidence);
  return result.value;
};

export const caseSensitivityOf = (target: string): CapabilityResult<boolean> => {
  const { directory, device } = deepestExistingDirectory(target);
  return resultForDirectory(directory, device);
};

export const volumeIsCaseInsensitive = (target: string): boolean => {
  const { directory, device } = deepestExistingDirectory(target);
  return verdictForDirectory(directory, device);
};

export const MAX_SYMLINK_HOPS = 40;

export type WalkEntry = { kind: 'missing' } | { kind: 'symlink'; target: string } | { kind: 'directory' } | { kind: 'other' };

export type WalkStep<F> = (absolutePath: string) => WalkEntry | { stepFailure: F };

export type WalkFailureDetail = 'parent-reference' | 'trailing-slash' | 'empty-link';

export type WalkFailureReason = { kind: 'errno'; code: 'ELOOP' | 'ENOENT' | 'ENOTDIR' };

export type WalkFailure = { reason: WalkFailureReason; candidate: string; prefix: string; detail?: WalkFailureDetail };

export type WalkResult<F> =
  | { ok: true; prefix: string; tail: readonly string[] }
  | { ok: false; failure: WalkFailure }
  | { ok: false; stepFailure: F; candidate: string; prefix: string };

export type StepRead = WalkEntry | Unresolved;

export type StepReader = (absolutePath: string) => StepRead;

const DIRECTORY_REQUIRED = '/';

const separatorsOf = (flavor: path.PlatformPath): RegExp => (flavor.sep === '\\' ? /[\\/]/ : /\//);

const endsWithSeparator = (value: string, flavor: path.PlatformPath): boolean => separatorsOf(flavor).test(value.slice(-1));

const componentsOf = (value: string, flavor: path.PlatformPath): string[] => {
  const components = value.split(separatorsOf(flavor)).filter((component) => component !== '' && component !== '.');
  return endsWithSeparator(value, flavor) ? [...components, DIRECTORY_REQUIRED] : components;
};

const errnoFailure = (code: 'ELOOP' | 'ENOENT' | 'ENOTDIR', candidate: string, prefix: string, detail?: WalkFailureDetail): WalkResult<never> => ({
  ok: false,
  failure: { reason: { kind: 'errno', code }, candidate, prefix, ...(detail === undefined ? {} : { detail }) },
});

export const walkPath = <F>(input: string, step: WalkStep<F>, onLink: (name: string) => void, flavor: path.PlatformPath = path): WalkResult<F> => {
  if (!flavor.isAbsolute(input)) throw new Error(`path must be absolute: ${input}`);
  const inputRoot = flavor.parse(input).root;
  const pending = componentsOf(input.slice(inputRoot.length), flavor).reverse();
  let prefix: string = inputRoot;
  let hops = MAX_SYMLINK_HOPS;
  while (pending.length > 0) {
    const component = pending.pop() as string;
    if (component === DIRECTORY_REQUIRED) continue;
    if (component === '..') {
      prefix = flavor.dirname(prefix);
      continue;
    }
    const candidate = flavor.join(prefix, component);
    const entry = step(candidate);
    if ('stepFailure' in entry) return { ok: false, stepFailure: entry.stepFailure, candidate, prefix };
    if (entry.kind === 'missing') {
      const tail = [component, ...pending.reverse()];
      if (tail.includes('..')) return errnoFailure('ENOENT', candidate, prefix, 'parent-reference');
      if (tail.includes(DIRECTORY_REQUIRED)) return errnoFailure('ENOENT', candidate, prefix, 'trailing-slash');
      return { ok: true, prefix, tail };
    }
    if (entry.kind === 'symlink') {
      onLink(candidate);
      hops -= 1;
      if (hops < 0) return errnoFailure('ELOOP', candidate, prefix);
      if (entry.target === '') return errnoFailure('ENOENT', candidate, prefix, 'empty-link');
      const targetRoot = flavor.isAbsolute(entry.target) ? flavor.parse(entry.target).root : '';
      if (targetRoot !== '') prefix = targetRoot;
      pending.push(...componentsOf(entry.target.slice(targetRoot.length), flavor).reverse());
      continue;
    }
    if (pending.length > 0 && entry.kind !== 'directory') return errnoFailure('ENOTDIR', candidate, prefix);
    prefix = candidate;
  }
  return { ok: true, prefix, tail: [] };
};

const nodeStep = (candidate: string): WalkEntry => {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  if (stat.isSymbolicLink()) return { kind: 'symlink', target: fs.readlinkSync(candidate) };
  return stat.isDirectory() ? { kind: 'directory' } : { kind: 'other' };
};

const codedError = (message: string, code: 'ELOOP' | 'ENOENT' | 'ENOTDIR'): NodeJS.ErrnoException => Object.assign(new Error(message), { code });

const walkFailureError = (input: string, failure: WalkFailure): NodeJS.ErrnoException => {
  const { code } = failure.reason;
  if (failure.detail === 'parent-reference') return codedError(`cannot resolve '..' below a missing component: ${input}`, code);
  if (failure.detail === 'trailing-slash') return codedError(`missing component followed by a slash: ${input}`, code);
  if (failure.detail === 'empty-link') return codedError(`empty symbolic link target: ${failure.candidate}`, code);
  if (code === 'ELOOP') return codedError(`too many symbolic links resolving ${input}`, code);
  return codedError(`not a directory: ${failure.candidate}`, code);
};

export const canonicalPath = (input: string): string => {
  const result = walkPath<never>(input, nodeStep, () => undefined);
  if (!result.ok) {
    if ('stepFailure' in result) {
      const unhandled: never = result.stepFailure;
      throw new Error(`canonicalPath: unexpected step failure ${String(unhandled)}`);
    }
    throw walkFailureError(input, result.failure);
  }
  return path.join(fs.realpathSync.native(result.prefix), ...result.tail);
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

const componentsOfPath = (value: string, flavor: path.PlatformPath = path): string[] => value.split(separatorsOf(flavor)).filter((component) => component !== '');

export const containsByComponents = (base: PathParts, candidate: PathParts, foldTail: boolean, flavor: path.PlatformPath = path): boolean => {
  const baseExisting = componentsOfPath(base.existing, flavor);
  const candidateExisting = componentsOfPath(candidate.existing, flavor);
  const baseAll = [...baseExisting, ...base.tail];
  const candidateAll = [...candidateExisting, ...candidate.tail];
  if (baseAll.length > candidateAll.length) return false;
  const exactCount = Math.min(baseExisting.length, candidateExisting.length);
  const driveFolds = flavor.sep === '\\';
  return baseAll.every((component, index) => {
    const other = candidateAll[index] as string;
    if (index === 0 && driveFolds) return component.toLowerCase() === other.toLowerCase();
    if (index < exactCount) return component === other;
    return foldTail ? component.toLowerCase() === other.toLowerCase() : component === other;
  });
};

export type LocatedParts = { parts: PathParts; caseInsensitive: boolean };

const throughFilesStep = (candidate: string): WalkEntry => {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    throw error;
  }
  if (stat.isSymbolicLink()) return { kind: 'symlink', target: fs.readlinkSync(candidate) };
  return { kind: 'directory' };
};

const canonicalThroughFiles = (value: string): string => {
  const result = walkPath<never>(value, throughFilesStep, () => undefined);
  if (!result.ok) {
    if ('stepFailure' in result) {
      const unhandled: never = result.stepFailure;
      throw new Error(`canonicalThroughFiles: unexpected step failure ${String(unhandled)}`);
    }
    throw walkFailureError(value, result.failure);
  }
  return path.join(fs.realpathSync.native(result.prefix), ...result.tail);
};

const locateWith = (value: string, canonicalise: (input: string) => string): LocatedParts => {
  if (!path.isAbsolute(value)) throw new Error(`path must be absolute: ${value}`);
  let resolved: string | undefined;
  try {
    resolved = canonicalise(value);
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

const locate = (value: string): LocatedParts => locateWith(value, canonicalPath);

export const locateThroughFiles = (value: string): LocatedParts => locateWith(value, canonicalThroughFiles);

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
