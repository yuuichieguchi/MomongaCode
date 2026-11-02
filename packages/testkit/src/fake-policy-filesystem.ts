import fs from 'node:fs';
import path from 'node:path';
import { EMPTY_PROTECTED_SET, gitlinksOfIndex, resolveCanonicalPath, volumeIsCaseInsensitive } from '@momonga/foundation';
import { TEST_HEARTBEAT_MS } from './test-support.ts';
import type { EntryRead, GitlinkRead, PathResolution, ProtectedSet, StepRead, Unresolved, UnresolvableErrno } from '@momonga/foundation';

export type FakeProgramResolution = { program: string } | { none: true };
export type FakeGlobExpansion = { matches: string[] } | { overflow: true } | Unresolved;

export type FakeHeadRead = { kind: 'symlink'; target: string } | { kind: 'text'; text: string } | { kind: 'invalid' };

export type FakePolicyFilesystem = {
  platform: NodeJS.Platform;
  canonicalise: (absolute: string) => PathResolution;
  volumeProbe: (directory: string) => boolean;
  resolveProgram: (name: string, cwd: string, searchPath: string | undefined, isWritable: (absolute: string) => boolean) => FakeProgramResolution;
  expandGlob: (pattern: string, cwd: string, limit: number) => FakeGlobExpansion;
  readEntry: (absolutePath: string) => EntryRead;
  readNoFollow: (absolutePath: string) => StepRead;
  readHead: (absolutePath: string) => FakeHeadRead;
  isSearchable: (absolutePath: string) => boolean;
  gitlinks: (gitDirectory: string) => GitlinkRead | Unresolved;
};

export type FakeResolveCall = { name: string; cwd: string; searchPath: string | undefined; isWritable: (absolute: string) => boolean };

export type RecordingPolicyFilesystem = FakePolicyFilesystem & { resolveCalls: FakeResolveCall[] };

export type FakePolicyFilesystemLayout = {
  platform?: NodeJS.Platform;
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

const GIT_HEADREF_BUFFER_BYTES = 256;
const HEAD_BYTES = GIT_HEADREF_BUFFER_BYTES - 1;

const PASSED_OVER_BY_GIT: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP', 'ENAMETOOLONG']);

const rejected = <T>(read: () => T, fallback: T): T => {
  try {
    return read();
  } catch (error) {
    if (PASSED_OVER_BY_GIT.has(errnoOf(error) ?? '')) return fallback;
    throw error;
  }
};

const readRealHead = (absolute: string): FakeHeadRead =>
  rejected<FakeHeadRead>(
    () => {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) return { kind: 'symlink', target: fs.readlinkSync(absolute) };
      if (!stat.isFile()) return { kind: 'invalid' };
      const descriptor = fs.openSync(absolute, 'r');
      try {
        const buffer = Buffer.alloc(HEAD_BYTES);
        return { kind: 'text', text: buffer.toString('latin1', 0, fs.readSync(descriptor, buffer, 0, HEAD_BYTES, 0)) };
      } finally {
        fs.closeSync(descriptor);
      }
    },
    { kind: 'invalid' },
  );

const headFromEntry = (entry: EntryRead): FakeHeadRead => ('unresolvable' in entry || entry.kind !== 'file' ? { kind: 'invalid' } : { kind: 'text', text: entry.text.slice(0, HEAD_BYTES) });

const isRealSearchable = (absolute: string): boolean =>
  rejected(() => {
    fs.lstatSync(absolute);
    fs.accessSync(absolute, fs.constants.X_OK);
    return true;
  }, false);

const noFollowFromEntry =(entry: EntryRead): StepRead => {
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
    platform: layout.platform ?? 'darwin',
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
    readHead: (absolute) => {
      const entry = entries[absolute];
      return entry === undefined ? readRealHead(absolute) : headFromEntry(entry);
    },
    isSearchable: (absolute) => {
      const entry = entries[absolute];
      if (entry === undefined) return isRealSearchable(absolute);
      return !('unresolvable' in entry) && entry.kind === 'directory';
    },
    gitlinks: (gitDirectory) => typedRead<GitlinkRead | Unresolved>(() => gitlinksOfIndex(fs.readFileSync(path.join(gitDirectory, 'index'))), new Set(['ENOENT', 'ENOTDIR']), { paths: [] }),
    ...layout.overrides,
  };
};

export type FakeGlobDeadline = { remainingMs: () => number };

export type HostOf<T extends FakePolicyFilesystem> = Omit<T, 'expandGlob'> & {
  expandGlob: (pattern: string, cwd: string, limit: number, deadline: FakeGlobDeadline) => Promise<FakeGlobExpansion>;
};

export const hostFilesystemOf = <T extends FakePolicyFilesystem>(fake: T): HostOf<T> => ({
  ...fake,
  expandGlob: async (pattern, cwd, limit) => fake.expandGlob(pattern, cwd, limit),
});

const LEASE_PER_HEARTBEAT = 3;

export const FAKE_LEASE = { leaseMs: LEASE_PER_HEARTBEAT * TEST_HEARTBEAT_MS, heartbeatMs: TEST_HEARTBEAT_MS } as const;

export const protectedSetWith = (roots: readonly string[], paths: readonly string[]): ProtectedSet => ({ ...EMPTY_PROTECTED_SET, roots, paths });

export const TEST_SEARCH_PATH = '/usr/bin:/bin';

export const isWritableFor =
  (roots: readonly string[]) =>
  (absolute: string): boolean =>
    roots.some((root) => absolute === root || absolute.startsWith(`${root}/`));
