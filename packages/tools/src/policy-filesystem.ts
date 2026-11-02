import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_POINTER_FILE_BYTES, resolveCanonicalPath, unresolvableReasonOf, volumeIsCaseInsensitive } from '@momonga/foundation';
import type { EntryRead, StepRead, Unresolved } from '@momonga/foundation';
import { systemProgramDirectories } from '@momonga/policy';
import type { GlobExpansion, HeadRead, PolicyFilesystem, ProgramResolution } from '@momonga/policy';
import { ShellNotFoundError, nodeShellPorts, resolveBashPath } from './builtins/shell.ts';
import type { ShellPorts } from './builtins/shell.ts';

const NOT_THERE: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);
const MISSING: ReadonlySet<string> = new Set(['ENOENT']);

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

const unresolvedOf = (error: unknown): Unresolved => {
  const reason = unresolvableReasonOf(error);
  if (reason === undefined) throw error;
  return { unresolvable: reason };
};

const isNotThere = (error: unknown): boolean => NOT_THERE.has(codeOf(error) ?? '');

const SKIPPED_ERRNO: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP', 'ENAMETOOLONG']);

type Holder = { apple: boolean; exact: boolean; unsafe: boolean; program: string };

const holdsProgram = (directory: string, name: string): boolean => {
  const file = path.join(directory, name);
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch (error) {
    if (SKIPPED_ERRNO.has(codeOf(error) ?? '')) return false;
    throw error;
  }
};

const holderAt = (system: readonly string[], entry: string, cwd: string, name: string, isWritable: (absolute: string) => boolean, unsafeBefore: boolean): Holder | undefined => {
  const directory = path.resolve(cwd, entry);
  if (!holdsProgram(directory, name)) return undefined;
  const absolute = path.isAbsolute(entry);
  return {
    apple: system.includes(directory),
    exact: absolute && system.includes(entry),
    unsafe: unsafeBefore || !absolute || isWritable(entry),
    program: path.join(directory, name),
  };
};

const resolveProgram = (platform: NodeJS.Platform) => (name: string, cwd: string, searchPath: string | undefined, isWritable: (absolute: string) => boolean): ProgramResolution => {
  if (searchPath === undefined) return { none: true };
  const system = systemProgramDirectories(platform);
  const entries = searchPath.split(':');
  let unsafeBefore = false;
  for (const [index, entry] of entries.entries()) {
    const landing = holderAt(system, entry, cwd, name, isWritable, unsafeBefore);
    if (landing !== undefined) {
      if (landing.apple) return landing.exact && !landing.unsafe ? { program: landing.program } : { none: true };
      if (!landing.unsafe) return { program: landing.program };
      const appleBehind = entries.slice(index + 1).some((later) => {
        const holder = holderAt(system, later, cwd, name, isWritable, true);
        return holder !== undefined && holder.exact;
      });
      return appleBehind ? { none: true } : { program: landing.program };
    }
    unsafeBefore = unsafeBefore || !path.isAbsolute(entry) || isWritable(entry);
  }
  return { none: true };
};

const typedRead = <T>(read: () => T, notThere: ReadonlySet<string>, absent: T): T | Unresolved => {
  try {
    return read();
  } catch (error) {
    if (notThere.has(codeOf(error) ?? '')) return absent;
    return unresolvedOf(error);
  }
};

const readEntry = (absolute: string): EntryRead =>
  typedRead<EntryRead>(
    () => {
      const stat = fs.statSync(absolute);
      if (stat.isDirectory()) return { kind: 'directory', canonical: fs.realpathSync.native(absolute) };
      if (!stat.isFile()) return { kind: 'file', text: '' };
      if (stat.size > MAX_POINTER_FILE_BYTES) return { kind: 'oversize' };
      return { kind: 'file', text: fs.readFileSync(absolute, 'utf8') };
    },
    NOT_THERE,
    { kind: 'absent' },
  );

const readNoFollow = (absolute: string): StepRead =>
  typedRead<StepRead>(
    () => {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) return { kind: 'symlink', target: fs.readlinkSync(absolute) };
      return stat.isDirectory() ? { kind: 'directory' } : { kind: 'other' };
    },
    MISSING,
    { kind: 'missing' },
  );

const HEAD_BYTES = 255;

const isErrno = (error: unknown): boolean => typeof codeOf(error) === 'string';

const rejectedByGit = <T>(read: () => T, rejected: T): T => {
  try {
    return read();
  } catch (error) {
    if (isErrno(error)) return rejected;
    throw error;
  }
};

const readHead = (absolute: string): HeadRead =>
  rejectedByGit<HeadRead>(
    () => {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) return { kind: 'symlink', target: fs.readlinkSync(absolute) };
      if (!stat.isFile()) return { kind: 'invalid' };
      const descriptor = fs.openSync(absolute, 'r');
      try {
        const buffer = Buffer.alloc(HEAD_BYTES);
        const length = fs.readSync(descriptor, buffer, 0, HEAD_BYTES, 0);
        return { kind: 'text', text: buffer.toString('latin1', 0, length) };
      } finally {
        fs.closeSync(descriptor);
      }
    },
    { kind: 'invalid' },
  );

const isSearchable = (absolute: string): boolean =>
  rejectedByGit(() => {
    fs.accessSync(absolute, fs.constants.X_OK);
    return true;
  }, false);

const GLOB_PROGRAM ='IFS=; shopt -s nullglob; for entry in $1; do printf "%s\\0" "$entry"; done';
const LOCALE_VARIABLES = ['LANG', 'LC_ALL', 'LC_COLLATE', 'LC_CTYPE'] as const;
const MAX_PATH_BYTES = 4096;

const globEnvironment = (): Record<string, string> =>
  Object.fromEntries(LOCALE_VARIABLES.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name] as string]])));

const expandGlob = (platform: NodeJS.Platform, shellPorts: ShellPorts) => (pattern: string, cwd: string, limit: number): GlobExpansion => {
  let shell: string;
  try {
    shell = resolveBashPath(platform, shellPorts);
  } catch (error) {
    if (error instanceof ShellNotFoundError) return { unresolvable: { kind: 'dynamic' } };
    throw error;
  }
  const result = spawnSync(shell, ['--noprofile', '--norc', '-c', GLOB_PROGRAM, 'glob', pattern], {
    cwd,
    env: globEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: (limit + 1) * (MAX_PATH_BYTES + 1),
  });
  if (result.error !== undefined) {
    const code = codeOf(result.error);
    if (code === 'ENOBUFS') return { overflow: true };
    if (code === 'ENOENT' || code === 'ENOTDIR') return { matches: [] };
    return unresolvedOf(result.error);
  }
  if (result.status !== 0) throw new Error(`glob expansion of ${pattern} failed with status ${String(result.status)}: ${result.stderr}`);
  const matches = result.stdout.split('\0').filter((entry) => entry !== '');
  return matches.length > limit ? { overflow: true } : { matches };
};

export const createPolicyFilesystem = (platform: NodeJS.Platform = process.platform, shellPorts: ShellPorts = nodeShellPorts()): PolicyFilesystem => ({
  platform,
  canonicalise: (absolute) => resolveCanonicalPath(absolute),
  volumeProbe: (directory) => volumeIsCaseInsensitive(directory),
  resolveProgram: resolveProgram(platform),
  expandGlob: expandGlob(platform, shellPorts),
  readEntry,
  readNoFollow,
  readHead,
  isSearchable,
});
