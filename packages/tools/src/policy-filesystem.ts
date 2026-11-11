import path from 'node:path';
import { MAX_POINTER_FILE_BYTES, gitlinksOfIndex, hostPaths, nodeFileSystem, programKeysOfConfig, someAsync, unresolvableReasonOf } from '@momonga/foundation';
import type { ConfigPrograms, EntryRead, GitlinkRead, StepRead, Unresolved } from '@momonga/foundation';
import { systemProgramDirectories } from '@momonga/policy';
import type { GlobDeadline, GlobExpander, GlobExpansion, HeadRead, PolicyHostFilesystem, ProgramResolution, WritableCheck } from '@momonga/policy';
import { ShellNotFoundError, resolveBashPath } from './builtins/shell.ts';
import type { ShellPorts } from './builtins/shell.ts';
import type { ChildPorts, PortChild } from './ports.ts';

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

const holdsProgram = async (directory: string, name: string): Promise<boolean> => {
  const file = path.join(directory, name);
  try {
    if (!(await nodeFileSystem.stat(file)).isFile()) return false;
    await nodeFileSystem.access(file, 'execute');
    return true;
  } catch (error) {
    if (SKIPPED_ERRNO.has(codeOf(error) ?? '')) return false;
    throw error;
  }
};

const holderAt = async (system: readonly string[], entry: string, cwd: string, name: string, isWritable: WritableCheck, unsafeBefore: boolean): Promise<Holder | undefined> => {
  const directory = path.resolve(cwd, entry);
  if (!(await holdsProgram(directory, name))) return undefined;
  const absolute = path.isAbsolute(entry);
  return {
    apple: system.includes(directory),
    exact: absolute && system.includes(entry),
    unsafe: unsafeBefore || !absolute || (await isWritable(entry)),
    program: path.join(directory, name),
  };
};

const searchPathDelimiterOf = (platform: NodeJS.Platform): string => (platform === 'win32' ? path.win32.delimiter : path.posix.delimiter);

const resolveProgram = (platform: NodeJS.Platform) => async (name: string, cwd: string, searchPath: string | undefined, isWritable: WritableCheck): Promise<ProgramResolution> => {
  if (searchPath === undefined) return { none: true };
  const system = systemProgramDirectories(platform);
  const entries = searchPath.split(searchPathDelimiterOf(platform));
  let unsafeBefore = false;
  for (const [index, entry] of entries.entries()) {
    const landing = await holderAt(system, entry, cwd, name, isWritable, unsafeBefore);
    if (landing !== undefined) {
      if (landing.apple) return landing.exact && !landing.unsafe ? { program: landing.program } : { none: true };
      if (!landing.unsafe) return { program: landing.program };
      const appleBehind = await someAsync(entries.slice(index + 1), async (later) => {
        const holder = await holderAt(system, later, cwd, name, isWritable, true);
        return holder !== undefined && holder.exact;
      });
      return appleBehind ? { none: true } : { program: landing.program };
    }
    unsafeBefore = unsafeBefore || !path.isAbsolute(entry) || (await isWritable(entry));
  }
  return { none: true };
};

const typedRead = async <T>(read: () => Promise<T>, notThere: ReadonlySet<string>, absent: T): Promise<T | Unresolved> => {
  try {
    return await read();
  } catch (error) {
    if (notThere.has(codeOf(error) ?? '')) return absent;
    return unresolvedOf(error);
  }
};

const readEntry = (absolute: string): Promise<EntryRead> =>
  typedRead<EntryRead>(
    async () => {
      const stat = await nodeFileSystem.stat(absolute);
      if (stat.isDirectory()) return { kind: 'directory', canonical: await nodeFileSystem.realpath(absolute) };
      if (!stat.isFile()) return { kind: 'file', text: '' };
      if (stat.size > MAX_POINTER_FILE_BYTES) return { kind: 'oversize' };
      const raw = Buffer.from(await nodeFileSystem.readFile(absolute));
      const text = raw.toString('utf8');
      return Buffer.from(text, 'utf8').equals(raw) ? { kind: 'file', text } : { unresolvable: { kind: 'dynamic' } };
    },
    NOT_THERE,
    { kind: 'absent' },
  );

const readNoFollow = (absolute: string): Promise<StepRead> =>
  typedRead<StepRead>(
    async () => {
      const stat = await nodeFileSystem.lstat(absolute);
      if (stat.isSymbolicLink()) {
        const raw = Buffer.from(await nodeFileSystem.readlinkBytes(absolute));
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

const rejectedByGit = async <T>(read: () => Promise<T>, rejected: T): Promise<T> => {
  try {
    return await read();
  } catch (error) {
    if (SKIPPED_ERRNO.has(codeOf(error) ?? '')) return rejected;
    throw error;
  }
};

const readHead = (absolute: string): Promise<HeadRead> =>
  rejectedByGit<HeadRead>(
    async () => {
      const stat = await nodeFileSystem.lstat(absolute);
      if (stat.isSymbolicLink()) return { kind: 'symlink', target: Buffer.from(await nodeFileSystem.readlinkBytes(absolute)).toString('latin1') };
      if (!stat.isFile()) return { kind: 'invalid' };
      return { kind: 'text', text: Buffer.from(await nodeFileSystem.readStart(absolute, HEAD_BYTES)).toString('latin1') };
    },
    { kind: 'invalid' },
  );

const isSearchable = (absolute: string): Promise<boolean> =>
  rejectedByGit(async () => {
    await nodeFileSystem.lstat(absolute);
    await nodeFileSystem.access(absolute, 'execute');
    return true;
  }, false);

const readGitlinks = (gitDirectory: string): Promise<GitlinkRead | Unresolved> =>
  typedRead<GitlinkRead | Unresolved>(async () => gitlinksOfIndex(Buffer.from(await nodeFileSystem.readFile(path.join(gitDirectory, 'index')))), NOT_THERE, { paths: [] });

const readConfigPrograms = (gitDirectory: string): Promise<ConfigPrograms | Unresolved> =>
  typedRead<ConfigPrograms | Unresolved>(
    async () => ({ keys: [...programKeysOfConfig(await nodeFileSystem.readTextFile(path.join(gitDirectory, 'config'))), ...(await configWorktreeKeys(gitDirectory))] }),
    NOT_THERE,
    { keys: [] },
  );

const configWorktreeKeys = async (gitDirectory: string): Promise<string[]> => {
  try {
    return programKeysOfConfig(await nodeFileSystem.readTextFile(path.join(gitDirectory, 'config.worktree')));
  } catch (error) {
    if (isNotThere(error)) return [];
    throw error;
  }
};

const GLOB_PROGRAM ='IFS=; shopt -s nullglob; for entry in $1; do printf "%s\\0" "$entry"; done';
const LOCALE_VARIABLES = ['LANG', 'LC_ALL', 'LC_COLLATE', 'LC_CTYPE'] as const;
const PATH_MAX_BYTES = 4096;
const KILL_SIGNAL = 'SIGKILL';
const DYNAMIC: GlobExpansion = { unresolvable: { kind: 'dynamic' } };

const globEnvironment = (env: ShellPorts['env']): Record<string, string> =>
  Object.fromEntries(
    LOCALE_VARIABLES.flatMap((name) => {
      const value = env[name];
      return value === undefined ? [] : [[name, value] as const];
    }),
  );

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

const runGlob = (ports: ChildPorts, env: Record<string, string>, shell: string, pattern: string, cwd: string, limit: number, deadline: GlobDeadline, signal: AbortSignal): Promise<GlobExpansion> =>
  new Promise((resolve, reject) => {
    const remaining = deadline.remainingMs();
    if (remaining <= 0 || signal.aborted) {
      resolve(DYNAMIC);
      return;
    }
    let child: PortChild;
    try {
      child = ports.spawn(shell, ['--noprofile', '--norc', '-c', GLOB_PROGRAM, 'glob', pattern], { cwd, env });
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
    let timer: unknown;
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
  (platform: NodeJS.Platform, shellPorts: ShellPorts, ports: ChildPorts): GlobExpander =>
  async (pattern, cwd, limit, deadline, signal) => {
    let shell: string;
    try {
      shell = await resolveBashPath(platform, shellPorts);
    } catch (error) {
      if (error instanceof ShellNotFoundError) return DYNAMIC;
      throw error;
    }
    return runGlob(ports, globEnvironment(shellPorts.env), shell, pattern, cwd, limit, deadline, signal);
  };

export const policyFilesystemOn = (platform: NodeJS.Platform, shellPorts: ShellPorts, childPorts: ChildPorts): PolicyHostFilesystem => ({
  platform,
  canonicalise: (absolute, signal) => hostPaths(signal).resolveCanonicalPath(absolute),
  volumeProbe: (directory, signal) => hostPaths(signal).volumeIsCaseInsensitive(directory),
  locate: (absolute, signal) => hostPaths(signal).locate(absolute),
  resolveProgram: resolveProgram(platform),
  expandGlob: createGlobExpander(platform, shellPorts, childPorts),
  readEntry,
  readNoFollow,
  readHead,
  isSearchable,
  gitlinks: readGitlinks,
  configPrograms: readConfigPrograms,
});
