import fs from 'node:fs';
import path from 'node:path';
import { EMPTY_PROTECTED_SET, resolveCanonicalPath, volumeIsCaseInsensitive } from '@momonga/foundation';
import type { EntryRead, PathResolution, ProtectedSet, StepRead, Unresolved, UnresolvableErrno } from '@momonga/foundation';

export type FakeProgramResolution = { program: string } | { none: true };
export type FakeGlobExpansion = { matches: string[] } | { overflow: true } | Unresolved;

export type FakePolicyFilesystem = {
  canonicalise: (absolute: string) => PathResolution;
  volumeProbe: (directory: string) => boolean;
  resolveProgram: (name: string, cwd: string, searchPath: string | undefined, isWritable: (absolute: string) => boolean) => FakeProgramResolution;
  expandGlob: (pattern: string, cwd: string, limit: number) => FakeGlobExpansion;
  readEntry: (absolutePath: string) => EntryRead;
  readNoFollow: (absolutePath: string) => StepRead;
};

export type FakeResolveCall = { name: string; cwd: string; searchPath: string | undefined; isWritable: (absolute: string) => boolean };

export type RecordingPolicyFilesystem = FakePolicyFilesystem & { resolveCalls: FakeResolveCall[] };

export type FakePolicyFilesystemLayout = {
  programs?: Readonly<Record<string, string>>;
  programsBySearchPath?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  globs?: Readonly<Record<string, FakeGlobExpansion>>;
  entries?: Readonly<Record<string, EntryRead>>;
  overrides?: Partial<FakePolicyFilesystem>;
};

export const APPLE_PROGRAMS: Readonly<Record<string, string>> = {
  mkdir: '/bin/mkdir',
  rmdir: '/bin/rmdir',
  rm: '/bin/rm',
  mv: '/bin/mv',
  cp: '/bin/cp',
  ls: '/bin/ls',
  cat: '/bin/cat',
  ps: '/bin/ps',
  touch: '/usr/bin/touch',
  sed: '/usr/bin/sed',
  head: '/usr/bin/head',
  tail: '/usr/bin/tail',
  wc: '/usr/bin/wc',
  grep: '/usr/bin/grep',
  diff: '/usr/bin/diff',
  stat: '/usr/bin/stat',
  du: '/usr/bin/du',
  which: '/usr/bin/which',
  file: '/usr/bin/file',
  sort: '/usr/bin/sort',
  find: '/usr/bin/find',
  git: '/usr/bin/git',
  tee: '/usr/bin/tee',
  nice: '/usr/bin/nice',
  nohup: '/usr/bin/nohup',
  stdbuf: '/usr/bin/stdbuf',
  env: '/usr/bin/env',
  xargs: '/usr/bin/xargs',
  timeout: '/opt/homebrew/bin/timeout',
};

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

const unresolved = (code: UnresolvableErrno): Unresolved => ({ unresolvable: { kind: 'errno', code } });

const UNRESOLVABLE: ReadonlySet<string> = new Set(['EACCES', 'ELOOP', 'ENAMETOOLONG', 'ENOTDIR']);

const typedRead = <T>(read: () => T, notThere: ReadonlySet<string>, absent: T): T | Unresolved => {
  try {
    return read();
  } catch (error) {
    const code = errnoOf(error) ?? '';
    if (notThere.has(code)) return absent;
    if (UNRESOLVABLE.has(code)) return unresolved(code as UnresolvableErrno);
    throw error;
  }
};

const readRealEntry = (absolute: string): EntryRead =>
  typedRead<EntryRead>(
    () => {
      const stat = fs.statSync(absolute);
      if (stat.isDirectory()) return { kind: 'directory', canonical: fs.realpathSync.native(absolute) };
      return { kind: 'file', text: fs.readFileSync(absolute, 'utf8') };
    },
    new Set(['ENOENT', 'ENOTDIR']),
    { kind: 'absent' },
  );

const readRealNoFollow = (absolute: string): StepRead =>
  typedRead<StepRead>(
    () => {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) return { kind: 'symlink', target: fs.readlinkSync(absolute) };
      return stat.isDirectory() ? { kind: 'directory' } : { kind: 'other' };
    },
    new Set(['ENOENT']),
    { kind: 'missing' },
  );

const noFollowFromEntry = (entry: EntryRead): StepRead => {
  if ('unresolvable' in entry) return entry;
  if (entry.kind === 'directory') return { kind: 'directory' };
  if (entry.kind === 'absent') return { kind: 'missing' };
  return { kind: 'other' };
};

export const fakePolicyFilesystem = (layout: FakePolicyFilesystemLayout = {}): RecordingPolicyFilesystem => {
  const programs = layout.programs ?? APPLE_PROGRAMS;
  const globs = layout.globs ?? {};
  const entries = layout.entries ?? {};
  const resolveCalls: FakeResolveCall[] = [];
  return {
    resolveCalls,
    canonicalise: (absolute) => resolveCanonicalPath(absolute),
    volumeProbe: (directory) => volumeIsCaseInsensitive(directory),
    resolveProgram: (name, cwd, searchPath, isWritable) => {
      resolveCalls.push({ name, cwd, searchPath, isWritable });
      if (searchPath === undefined) return { none: true };
      const found = (layout.programsBySearchPath?.[searchPath] ?? programs)[name];
      if (found === undefined) return { none: true };
      return { program: found };
    },
    expandGlob: (pattern, cwd) => globs[path.resolve(cwd, pattern)] ?? globs[pattern] ?? { matches: [] },
    readEntry: (absolute) => entries[absolute] ?? readRealEntry(absolute),
    readNoFollow: (absolute) => {
      const entry = entries[absolute];
      return entry === undefined ? readRealNoFollow(absolute) : noFollowFromEntry(entry);
    },
    ...layout.overrides,
  };
};

export const protectedSetWith = (roots: readonly string[], paths: readonly string[]): ProtectedSet => ({ ...EMPTY_PROTECTED_SET, roots, paths });

export const TEST_SEARCH_PATH = '/usr/bin:/bin';

export const isWritableFor =
  (roots: readonly string[]) =>
  (absolute: string): boolean =>
    roots.some((root) => absolute === root || absolute.startsWith(`${root}/`));
