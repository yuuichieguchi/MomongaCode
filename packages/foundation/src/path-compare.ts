import path from 'node:path';
import type { DirectoryReader, FileSystem } from './node-file-system.ts';
import { nodeFileSystem } from './node-file-system.ts';
import { settledOrAborted } from './operation-limit.ts';
import { unresolvableReasonOf } from './path-resolution.ts';
import type { PathResolution, Unresolved } from './path-resolution.ts';
import { isTransientErrno } from './transient-errno.ts';
import { unmeasuredBecause } from './capability-probe.ts';
import type { CapabilityResult } from './capability-probe.ts';

export type PathFileSystem = Pick<FileSystem, 'stat' | 'lstat' | 'readlink' | 'realpath' | 'openDirectory' | 'access'>;

type FileStats = Awaited<ReturnType<PathFileSystem['stat']>>;

export type CaseSensitivityProbe = (existingDirectory: string) => boolean | undefined | Promise<boolean | undefined>;

const flipCase = (value: string): string =>
  [...value].map((char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase())).join('');

const hasLetter = (value: string): boolean => value.toLowerCase() !== value.toUpperCase();

let caseSensitivityOverride: CaseSensitivityProbe | undefined;
type VolumeVerdict = { rootPath: string; rootIno: number; result: CapabilityResult<boolean> };

const caseFoldingByDevice = new Map<number, VolumeVerdict>();

export const setCaseSensitivityProbe = (probe: CaseSensitivityProbe | undefined): void => {
  caseSensitivityOverride = probe;
  caseFoldingByDevice.clear();
};

const UNDETERMINED = 'case sensitivity of this volume could not be determined';

export const MAX_SYMLINK_HOPS = 40;

export type WalkEntry = { kind: 'missing' } | { kind: 'symlink'; target: string } | { kind: 'directory' } | { kind: 'other' };

export type WalkStepResult<F> = WalkEntry | { stepFailure: F };

export type WalkStep<F> = (absolutePath: string) => WalkStepResult<F> | Promise<WalkStepResult<F>>;

export type WalkFailureDetail = 'parent-reference' | 'trailing-slash' | 'empty-link';

export type WalkFailureReason = { kind: 'errno'; code: 'ELOOP' | 'ENOENT' | 'ENOTDIR' };

export type WalkFailure = { reason: WalkFailureReason; candidate: string; prefix: string; detail?: WalkFailureDetail };

export type WalkResult<F> =
  | { ok: true; prefix: string; tail: readonly string[] }
  | { ok: false; failure: WalkFailure }
  | { ok: false; stepFailure: F; candidate: string; prefix: string };

export type StepRead = WalkEntry | Unresolved;

export type StepReader = (absolutePath: string) => StepRead | Promise<StepRead>;

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

function* walkSteps<F>(input: string, onLink: (name: string) => void, flavor: path.PlatformPath): Generator<string, WalkResult<F>, WalkStepResult<F>> {
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
    const entry = yield candidate;
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
}

export const walkPath = async <F>(input: string, step: WalkStep<F>, onLink: (name: string) => void, flavor: path.PlatformPath = path): Promise<WalkResult<F>> => {
  const steps = walkSteps<F>(input, onLink, flavor);
  let next = steps.next();
  while (next.done !== true) next = steps.next(await step(next.value));
  return next.value;
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

export type CanonicalDirectoryFailureCode = 'not_absolute' | 'unresolvable' | 'missing' | 'not_directory' | 'unreadable';

export type CanonicalDirectoryResult =
  | { ok: true; path: string }
  | { ok: false; code: CanonicalDirectoryFailureCode; reason: string };

const UNRESOLVABLE_ERRNO = new Set(['ENOTDIR', 'ELOOP', 'ENAMETOOLONG']);

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

export const comparableFromParts = (parts: PathParts, foldTail: boolean): string =>
  path.join(parts.existing, ...(foldTail ? parts.tail.map((component) => component.toLowerCase()) : parts.tail));

export type LocatedParts = { parts: PathParts; caseInsensitive: boolean };

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

type DirectoryHandle = { readonly directory: string };

type Ask =
  | { op: 'stat' | 'lstat' | 'readlink' | 'realpath' | 'list' | 'open'; target: string }
  | { op: 'read' | 'close'; handle: DirectoryHandle }
  | { op: 'probe'; probe: CaseSensitivityProbe; directory: string }
  | { op: 'cancelled' };

type Asking<T> = Generator<Ask, T, unknown>;

function* ask<T>(question: Ask): Asking<T> {
  return (yield question) as T;
}

const statOf = (target: string): Asking<FileStats> => ask({ op: 'stat', target });

function* statIfPresent(target: string): Asking<FileStats | undefined> {
  try {
    return yield* statOf(target);
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'ELOOP') return undefined;
    throw error;
  }
}

function* compareEntryWithFlippedCase(entry: string, device: number): Asking<boolean | undefined> {
  const original = yield* statIfPresent(entry);
  if (original === undefined || original.dev !== device) return undefined;
  const flipped = path.join(path.dirname(entry), flipCase(path.basename(entry)));
  const variant = yield* statIfPresent(flipped);
  if (variant === undefined) return false;
  return variant.dev === original.dev && variant.ino === original.ino;
}

function* firstVerdictAmong(handle: DirectoryHandle, directory: string, device: number): Asking<boolean | undefined> {
  try {
    for (;;) {
      const name = yield* ask<string | null>({ op: 'read', handle });
      if (name === null) return undefined;
      if (!hasLetter(name)) continue;
      const verdict = yield* compareEntryWithFlippedCase(path.join(directory, name), device);
      if (verdict !== undefined) return verdict;
    }
  } finally {
    yield* ask<void>({ op: 'close', handle });
  }
}

function* probeCaseFolding(directory: string): Asking<boolean | undefined> {
  const device = (yield* statOf(directory)).dev;
  let current = directory;
  while (current !== path.dirname(current)) {
    const parent = path.dirname(current);
    if (hasLetter(path.basename(current)) && (yield* statIfPresent(parent))?.dev === device) {
      const verdict = yield* compareEntryWithFlippedCase(current, device);
      if (verdict !== undefined) return verdict;
    }
    current = parent;
  }
  let handle: DirectoryHandle;
  try {
    handle = yield* ask<DirectoryHandle>({ op: 'open', target: directory });
  } catch (error) {
    if (errnoOf(error) === 'EACCES') return undefined;
    throw error;
  }
  return yield* firstVerdictAmong(handle, directory, device);
}

function* deepestExistingDirectory(target: string): Asking<{ directory: string; device: number }> {
  let current = target;
  for (;;) {
    const stat = yield* statIfPresent(current);
    if (stat?.isDirectory()) return { directory: current, device: stat.dev };
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`no existing directory found for ${target}`);
    current = parent;
  }
}

function* mountRootOf(directory: string, device: number): Asking<string> {
  let mountRoot = directory;
  for (;;) {
    const parent = path.dirname(mountRoot);
    if (parent === mountRoot || (yield* statIfPresent(parent))?.dev !== device) return mountRoot;
    mountRoot = parent;
  }
}

function* rethrowIfCancelled(): Asking<void> {
  yield* ask<void>({ op: 'cancelled' });
}

function* measureCaseSensitivity(directory: string): Asking<CapabilityResult<boolean>> {
  let verdict: boolean | undefined;
  try {
    verdict = caseSensitivityOverride === undefined ? yield* probeCaseFolding(directory) : yield* ask<boolean | undefined>({ op: 'probe', probe: caseSensitivityOverride, directory });
  } catch (error) {
    yield* rethrowIfCancelled();
    const reason = unmeasuredBecause(error).evidence;
    return { kind: 'unmeasured', evidence: `${UNDETERMINED}: ${reason} (${directory})` };
  }
  if (verdict === undefined) {
    return { kind: 'unsupported', evidence: `${UNDETERMINED}: no entry on the volume could be compared in a different case (${directory})` };
  }
  return { kind: 'supported', value: verdict, evidence: `measured on the volume of ${directory}` };
}

function* resultForDirectory(directory: string, device: number): Asking<CapabilityResult<boolean>> {
  const cached = caseFoldingByDevice.get(device);
  if (cached !== undefined) {
    const root = yield* statIfPresent(cached.rootPath);
    if (root !== undefined && root.dev === device && root.ino === cached.rootIno) return cached.result;
  }
  const rootPath = yield* mountRootOf(directory, device);
  const rootIno = (yield* statIfPresent(rootPath))?.ino as number;
  const result = yield* measureCaseSensitivity(directory);
  if (result.kind === 'unmeasured') caseFoldingByDevice.delete(device);
  else caseFoldingByDevice.set(device, { rootPath, rootIno, result });
  return result;
}

function* verdictForDirectory(directory: string, device: number): Asking<boolean> {
  const result = yield* resultForDirectory(directory, device);
  if (result.kind !== 'supported') throw new Error(result.evidence);
  return result.value;
}

function* caseSensitivityOf(target: string): Asking<CapabilityResult<boolean>> {
  const { directory, device } = yield* deepestExistingDirectory(target);
  return yield* resultForDirectory(directory, device);
}

function* volumeIsCaseInsensitive(target: string): Asking<boolean> {
  const { directory, device } = yield* deepestExistingDirectory(target);
  return yield* verdictForDirectory(directory, device);
}

type Step = (candidate: string) => Asking<WalkEntry>;

const stepMissingOn = (missing: ReadonlySet<string>, kindOf: (stat: FileStats) => WalkEntry): Step =>
  function* (candidate) {
    let stat: FileStats;
    try {
      stat = yield* ask<FileStats>({ op: 'lstat', target: candidate });
    } catch (error) {
      if (missing.has(errnoOf(error) ?? '')) return { kind: 'missing' };
      throw error;
    }
    return stat.isSymbolicLink() ? { kind: 'symlink', target: yield* ask<string>({ op: 'readlink', target: candidate }) } : kindOf(stat);
  };

const followingStep = stepMissingOn(new Set(['ENOENT']), (stat) => (stat.isDirectory() ? { kind: 'directory' } : { kind: 'other' }));

const throughFilesStep = stepMissingOn(new Set(['ENOENT', 'ENOTDIR']), () => ({ kind: 'directory' }));

function* canonicalWith(input: string, step: Step): Asking<string> {
  const steps = walkSteps<never>(input, () => undefined, path);
  let next = steps.next();
  while (next.done !== true) next = steps.next(yield* step(next.value));
  const result = next.value;
  if (!result.ok) {
    if ('stepFailure' in result) {
      const unhandled: never = result.stepFailure;
      throw new Error(`canonical path: unexpected step failure ${String(unhandled)}`);
    }
    throw walkFailureError(input, result.failure);
  }
  return path.join(yield* ask<string>({ op: 'realpath', target: result.prefix }), ...result.tail);
}

const canonicalPath = (input: string): Asking<string> => canonicalWith(input, followingStep);

const canonicalThroughFiles = (value: string): Asking<string> => canonicalWith(value, throughFilesStep);

const DENIED_ERRNO: ReadonlyMap<string, string> = new Map([
  ['EACCES', 'permission denied'],
  ['EPERM', 'operation not permitted'],
]);

const deniedOrRethrown = (error: unknown): CanonicalDirectoryResult => {
  const code = errnoOf(error);
  const denial = code === undefined ? undefined : DENIED_ERRNO.get(code);
  if (denial === undefined) throw error;
  return { ok: false, code: 'unreadable', reason: `cannot be read: ${denial} (${code})` };
};

function* canonicalDirectory(input: string): Asking<CanonicalDirectoryResult> {
  if (!path.isAbsolute(input)) return { ok: false, code: 'not_absolute', reason: 'must be an absolute path' };
  let canonical: string;
  try {
    canonical = yield* canonicalPath(input);
  } catch (error) {
    yield* rethrowIfCancelled();
    if (isTransientErrno(error)) throw error;
    return { ok: false, code: 'unresolvable', reason: `cannot be resolved: ${(error as Error).message}` };
  }
  let stat: FileStats;
  try {
    stat = yield* statOf(canonical);
  } catch (error) {
    yield* rethrowIfCancelled();
    const code = errnoOf(error);
    if (isTransientErrno(error)) throw error;
    if (code === 'ENOENT') return { ok: false, code: 'missing', reason: 'does not exist' };
    if (code !== undefined && UNRESOLVABLE_ERRNO.has(code)) {
      return { ok: false, code: 'unresolvable', reason: `cannot be resolved: ${(error as Error).message}` };
    }
    return deniedOrRethrown(error);
  }
  if (!stat.isDirectory()) return { ok: false, code: 'not_directory', reason: 'is not a directory' };
  try {
    yield* ask<void>({ op: 'list', target: canonical });
  } catch (error) {
    yield* rethrowIfCancelled();
    return deniedOrRethrown(error);
  }
  return { ok: true, path: canonical };
}

function* resolved(absolute: string): Asking<PathResolution> {
  try {
    return { ok: true, path: yield* canonicalPath(absolute) };
  } catch (error) {
    const reason = unresolvableReasonOf(error);
    if (reason === undefined) throw error;
    return { ok: false, reason };
  }
}

function* locateWith(value: string, canonicalise: (input: string) => Asking<string>): Asking<LocatedParts> {
  if (!path.isAbsolute(value)) throw new Error(`path must be absolute: ${value}`);
  let canonical: string | undefined;
  try {
    canonical = yield* canonicalise(value);
  } catch (error) {
    if (errnoOf(error) !== 'EACCES') throw error;
  }
  const { directory, device } = yield* deepestExistingDirectory(canonical ?? value);
  const existing = canonical === undefined ? yield* ask<string>({ op: 'realpath', target: directory }) : directory;
  return {
    parts: { existing, tail: componentsOfPath(path.relative(directory, canonical ?? value)) },
    caseInsensitive: yield* verdictForDirectory(directory, device),
  };
}

const locate = (value: string): Asking<LocatedParts> => locateWith(value, canonicalPath);

const locateThroughFiles = (value: string): Asking<LocatedParts> => locateWith(value, canonicalThroughFiles);

function* comparablePath(input: string): Asking<string> {
  const { parts, caseInsensitive } = yield* locate(input);
  return comparableFromParts(parts, caseInsensitive);
}

function* comparableContains(directory: string, candidate: string): Asking<boolean> {
  const located = yield* locate(candidate);
  return containsByComponents((yield* locate(directory)).parts, located.parts, located.caseInsensitive);
}

function* realPath(target: string): Asking<string> {
  return yield* ask<string>({ op: 'realpath', target });
}

type Questions = {
  canonicalPath: typeof canonicalPath;
  canonicalDirectory: typeof canonicalDirectory;
  resolveCanonicalPath: typeof resolved;
  locate: typeof locate;
  locateThroughFiles: typeof locateThroughFiles;
  comparablePath: typeof comparablePath;
  comparableContains: typeof comparableContains;
  volumeIsCaseInsensitive: typeof volumeIsCaseInsensitive;
  caseSensitivityOf: typeof caseSensitivityOf;
  realPath: typeof realPath;
};

type Answered<Wrapped extends 'now' | 'later'> = {
  [Name in keyof Questions]: Questions[Name] extends (...args: infer Args) => Asking<infer Answer> ? (...args: Args) => Wrapped extends 'now' ? Answer : Promise<Answer> : never;
};

export type PathResolver = Answered<'later'>;

export type SyncPathResolver = Answered<'now'>;

type Turn = { done: false; value: Ask } | { done: true; value: unknown };

const turnOf = (advance: () => IteratorResult<Ask, unknown>): Turn => {
  const next = advance();
  return next.done === true ? { done: true, value: next.value } : { done: false, value: next.value };
};

export const createPathResolver = (files: PathFileSystem, signal: AbortSignal): PathResolver => {
  const readers = new WeakMap<DirectoryHandle, DirectoryReader>();
  const readerOf = (handle: DirectoryHandle): DirectoryReader => {
    const reader = readers.get(handle);
    if (reader === undefined) throw new Error(`the directory ${handle.directory} is not open`);
    return reader;
  };
  const answer = async (question: Ask): Promise<unknown> => {
    switch (question.op) {
      case 'stat':
        return files.stat(question.target);
      case 'lstat':
        return files.lstat(question.target);
      case 'readlink':
        return files.readlink(question.target);
      case 'realpath':
        return files.realpath(question.target);
      case 'list':
        return files.access(question.target, 'list');
      case 'open': {
        const handle: DirectoryHandle = { directory: question.target };
        readers.set(handle, await files.openDirectory(question.target));
        return handle;
      }
      case 'read':
        return readerOf(question.handle).read();
      case 'close':
        return readerOf(question.handle).close();
      case 'probe':
        return question.probe(question.directory);
      case 'cancelled':
        return signal.throwIfAborted();
    }
  };
  const answered = async <T>(questions: Asking<T>): Promise<T> => {
    let turn = turnOf(() => questions.next());
    while (!turn.done) {
      let reply: { value: unknown } | { error: unknown };
      try {
        reply = { value: await settledOrAborted(answer(turn.value), signal) };
      } catch (error) {
        reply = { error };
      }
      const given = reply;
      turn = turnOf(() => ('error' in given ? questions.throw(given.error) : questions.next(given.value)));
    }
    return turn.value as T;
  };
  return {
    canonicalPath: (input) => answered(canonicalPath(input)),
    canonicalDirectory: (input) => answered(canonicalDirectory(input)),
    resolveCanonicalPath: (absolute) => answered(resolved(absolute)),
    locate: (value) => answered(locate(value)),
    locateThroughFiles: (value) => answered(locateThroughFiles(value)),
    comparablePath: (input) => answered(comparablePath(input)),
    comparableContains: (directory, candidate) => answered(comparableContains(directory, candidate)),
    volumeIsCaseInsensitive: (target) => answered(volumeIsCaseInsensitive(target)),
    caseSensitivityOf: (target) => answered(caseSensitivityOf(target)),
    realPath: (target) => answered(realPath(target)),
  };
};

export const hostPaths = (signal: AbortSignal): PathResolver => createPathResolver(nodeFileSystem, signal);

export type SyncPathFileSystem = {
  stat(target: string): FileStats;
  lstat(target: string): FileStats;
  readlink(target: string): string;
  realpath(target: string): string;
  list(target: string): void;
  names(directory: string): string[];
};

export const createSyncPathResolver = (files: SyncPathFileSystem): SyncPathResolver => {
  const listings = new WeakMap<DirectoryHandle, string[]>();
  const answer = (question: Ask): unknown => {
    switch (question.op) {
      case 'stat':
        return files.stat(question.target);
      case 'lstat':
        return files.lstat(question.target);
      case 'readlink':
        return files.readlink(question.target);
      case 'realpath':
        return files.realpath(question.target);
      case 'list':
        return files.list(question.target);
      case 'open': {
        const handle: DirectoryHandle = { directory: question.target };
        listings.set(handle, files.names(question.target).reverse());
        return handle;
      }
      case 'read':
        return listings.get(question.handle)?.pop() ?? null;
      case 'close':
        return undefined;
      case 'probe': {
        const verdict = question.probe(question.directory);
        if (verdict instanceof Promise) throw new Error('a synchronous path resolution cannot wait for an asynchronous case-sensitivity probe');
        return verdict;
      }
      case 'cancelled':
        return undefined;
    }
  };
  const answered = <T>(questions: Asking<T>): T => {
    let turn = turnOf(() => questions.next());
    while (!turn.done) {
      let reply: { value: unknown } | { error: unknown };
      try {
        reply = { value: answer(turn.value) };
      } catch (error) {
        reply = { error };
      }
      const given = reply;
      turn = turnOf(() => ('error' in given ? questions.throw(given.error) : questions.next(given.value)));
    }
    return turn.value as T;
  };
  return {
    canonicalPath: (input) => answered(canonicalPath(input)),
    canonicalDirectory: (input) => answered(canonicalDirectory(input)),
    resolveCanonicalPath: (absolute) => answered(resolved(absolute)),
    locate: (value) => answered(locate(value)),
    locateThroughFiles: (value) => answered(locateThroughFiles(value)),
    comparablePath: (input) => answered(comparablePath(input)),
    comparableContains: (directory, candidate) => answered(comparableContains(directory, candidate)),
    volumeIsCaseInsensitive: (target) => answered(volumeIsCaseInsensitive(target)),
    caseSensitivityOf: (target) => answered(caseSensitivityOf(target)),
    realPath: (target) => answered(realPath(target)),
  };
};
