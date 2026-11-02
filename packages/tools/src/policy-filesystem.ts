import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { MAX_POINTER_FILE_BYTES, resolveCanonicalPath, unresolvableReasonOf, volumeIsCaseInsensitive } from '@momonga/foundation';
import type { EntryRead, StepRead, Unresolved } from '@momonga/foundation';
import { systemProgramDirectories } from '@momonga/policy';
import type { GlobDeadline, GlobExpander, GlobExpansion, HeadRead, PolicyHostFilesystem, ProgramResolution } from '@momonga/policy';
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
      const raw = fs.readFileSync(absolute);
      const text = raw.toString('utf8');
      return Buffer.from(text, 'utf8').equals(raw) ? { kind: 'file', text } : { unresolvable: { kind: 'dynamic' } };
    },
    NOT_THERE,
    { kind: 'absent' },
  );

const readNoFollow = (absolute: string): StepRead =>
  typedRead<StepRead>(
    () => {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        const raw = fs.readlinkSync(absolute, 'buffer');
        const target = raw.toString('utf8');
        return Buffer.from(target, 'utf8').equals(raw) ? { kind: 'symlink', target } : { unresolvable: { kind: 'dynamic' } };
      }
      return stat.isDirectory() ? { kind: 'directory' } : { kind: 'other' };
    },
    MISSING,
    { kind: 'missing' },
  );

const GIT_HEADREF_BUFFER_BYTES = 256;
const HEAD_BYTES = GIT_HEADREF_BUFFER_BYTES - 1;

const rejectedByGit = <T>(read: () => T, rejected: T): T => {
  try {
    return read();
  } catch (error) {
    if (SKIPPED_ERRNO.has(codeOf(error) ?? '')) return rejected;
    throw error;
  }
};

const readHead = (absolute: string): HeadRead =>
  rejectedByGit<HeadRead>(
    () => {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) return { kind: 'symlink', target: fs.readlinkSync(absolute, 'buffer').toString('latin1') };
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
    fs.lstatSync(absolute);
    fs.accessSync(absolute, fs.constants.X_OK);
    return true;
  }, false);

const GLOB_PROGRAM ='IFS=; shopt -s nullglob; for entry in $1; do printf "%s\\0" "$entry"; done';
const LOCALE_VARIABLES = ['LANG', 'LC_ALL', 'LC_COLLATE', 'LC_CTYPE'] as const;
const PATH_MAX_BYTES = 4096;
const KILL_SIGNAL = 'SIGKILL';
const DYNAMIC: GlobExpansion = { unresolvable: { kind: 'dynamic' } };

const globEnvironment = (): Record<string, string> =>
  Object.fromEntries(LOCALE_VARIABLES.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name] as string]])));

export type GlobChild = EventEmitter & {
  stdout: Readable | null | undefined;
  stderr: Readable | null | undefined;
  kill(signal: NodeJS.Signals): boolean;
  unref(): void;
};

export type GlobPorts = {
  spawn(file: string, args: readonly string[], options: { cwd: string; env: Record<string, string> }): GlobChild;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
};

export const nodeGlobPorts = (): GlobPorts => ({
  spawn: (file, args, options) => spawn(file, [...args], { ...options, stdio: ['ignore', 'pipe', 'pipe'] }),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
});

const entriesOf = (output: Buffer): string[] | undefined => {
  const entries: string[] = [];
  let start = 0;
  for (let end = output.indexOf(0, start); end !== -1; end = output.indexOf(0, start)) {
    const raw = output.subarray(start, end);
    start = end + 1;
    if (raw.length === 0) continue;
    const text = raw.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(raw)) return undefined;
    entries.push(text);
  }
  return entries;
};

const countSeparators = (chunk: Buffer): number => {
  let count = 0;
  for (let at = chunk.indexOf(0); at !== -1; at = chunk.indexOf(0, at + 1)) count += 1;
  return count;
};

const runGlob = (ports: GlobPorts, shell: string, pattern: string, cwd: string, limit: number, deadline: GlobDeadline, signal: AbortSignal): Promise<GlobExpansion> =>
  new Promise((resolve, reject) => {
    const remaining = deadline.remainingMs();
    if (remaining <= 0 || signal.aborted) {
      resolve(DYNAMIC);
      return;
    }
    let child: GlobChild;
    try {
      child = ports.spawn(shell, ['--noprofile', '--norc', '-c', GLOB_PROGRAM, 'glob', pattern], { cwd, env: globEnvironment() });
    } catch (error) {
      if (codeOf(error) === 'E2BIG') resolve(DYNAMIC);
      else reject(error);
      return;
    }
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let separators = 0;
    let errorBytes = 0;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abandon = (): void => {
      child.kill(KILL_SIGNAL);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    };
    const onAbort = (): void =>
      settle(() => {
        abandon();
        return DYNAMIC;
      });
    const settle = (finish: () => GlobExpansion): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) ports.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      try {
        resolve(finish());
      } catch (error) {
        reject(error);
      }
    };
    child.on('error', (error: Error) =>
      settle(() => {
        abandon();
        const code = codeOf(error);
        if (code === 'ENOENT' || code === 'ENOTDIR') return { matches: [] };
        return unresolvedOf(error);
      }),
    );
    timer = ports.setTimeout(
      () =>
        settle(() => {
          abandon();
          return DYNAMIC;
        }),
      remaining,
    );
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (done) return;
      output.push(chunk);
      separators += countSeparators(chunk);
      if (separators > limit) {
        settle(() => {
          abandon();
          return { overflow: true };
        });
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (done || errorBytes >= PATH_MAX_BYTES) return;
      errors.push(chunk);
      errorBytes += chunk.length;
    });
    child.on('close', (status: number | null) =>
      settle(() => {
        if (status !== 0) throw new Error(`glob expansion of ${pattern} failed with status ${String(status)}: ${Buffer.concat(errors).toString('utf8')}`);
        const entries = entriesOf(Buffer.concat(output));
        if (entries === undefined) return DYNAMIC;
        return entries.length > limit ? { overflow: true } : { matches: entries };
      }),
    );
  });

export const createGlobExpander =
  (platform: NodeJS.Platform, shellPorts: ShellPorts, ports: GlobPorts): GlobExpander =>
  async (pattern, cwd, limit, deadline, signal) => {
    let shell: string;
    try {
      shell = resolveBashPath(platform, shellPorts);
    } catch (error) {
      if (error instanceof ShellNotFoundError) return DYNAMIC;
      throw error;
    }
    return runGlob(ports, shell, pattern, cwd, limit, deadline, signal);
  };

export const createPolicyFilesystem = (
  platform: NodeJS.Platform = process.platform,
  shellPorts: ShellPorts = nodeShellPorts(),
  globPorts: GlobPorts = nodeGlobPorts(),
): PolicyHostFilesystem => ({
  platform,
  canonicalise: (absolute) => resolveCanonicalPath(absolute),
  volumeProbe: (directory) => volumeIsCaseInsensitive(directory),
  resolveProgram: resolveProgram(platform),
  expandGlob: createGlobExpander(platform, shellPorts, globPorts),
  readEntry,
  readNoFollow,
  readHead,
  isSearchable,
});
