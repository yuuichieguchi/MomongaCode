import path from 'node:path';
import type { FileSystem, FileSystemSync } from './node-file-system.ts';
import type { Awaitable } from './path-resolution.ts';

export type SearchEnv = Readonly<Record<string, string | undefined>>;

export type ProgramSearchFiles = Pick<FileSystem, 'stat' | 'access'>;

export type ProgramSearchFilesSync = Pick<FileSystemSync, 'statSync' | 'accessSync'>;

const NOT_A_PROGRAM: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP']);

const isNotAProgram = (error: unknown): boolean => error instanceof Error && NOT_A_PROGRAM.has((error as NodeJS.ErrnoException).code ?? '');

const namesOf = (program: string, env: SearchEnv): string[] => {
  const extensions = (env['PATHEXT'] ?? '').split(';').filter((extension) => extension !== '');
  return [program, ...extensions.map((extension) => `${program}${extension.toLowerCase()}`), ...extensions.map((extension) => `${program}${extension}`)];
};

const programCandidatesOf = (program: string, env: SearchEnv): string[] =>
  (env['PATH'] ?? '')
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry))
    .flatMap((entry) => namesOf(program, env).map((name) => path.join(entry, name)));

const isExecutableFile = async (files: ProgramSearchFiles, candidate: string): Promise<boolean> => {
  try {
    if (!(await files.stat(candidate)).isFile()) return false;
    await files.access(candidate, 'execute');
    return true;
  } catch (error) {
    if (isNotAProgram(error)) return false;
    throw error;
  }
};

const isExecutableFileSync = (files: ProgramSearchFilesSync, candidate: string): boolean => {
  try {
    if (!files.statSync(candidate).isFile()) return false;
    files.accessSync(candidate, 'execute');
    return true;
  } catch (error) {
    if (isNotAProgram(error)) return false;
    throw error;
  }
};

export const findProgramOnPath = async (program: string, env: SearchEnv, files: ProgramSearchFiles): Promise<string | undefined> => {
  for (const candidate of programCandidatesOf(program, env)) if (await isExecutableFile(files, candidate)) return candidate;
  return undefined;
};

export const findProgramOnPathSync = (program: string, env: SearchEnv, files: ProgramSearchFilesSync): string | undefined =>
  programCandidatesOf(program, env).find((candidate) => isExecutableFileSync(files, candidate));

export type ProgramResolution = { program: string } | { none: true };

export type WritableCheck = (absolute: string) => Awaitable<boolean>;

export type ProgramHolds = (directory: string, name: string) => Awaitable<boolean>;

export const SYSTEM_PROGRAM_DIRECTORIES: Readonly<Record<'darwin' | 'linux', readonly string[]>> = {
  darwin: ['/bin', '/usr/bin'],
  linux: ['/bin', '/usr/bin'],
};

export const systemProgramDirectories = (platform: NodeJS.Platform): readonly string[] =>
  platform === 'darwin' ? SYSTEM_PROGRAM_DIRECTORIES.darwin : platform === 'linux' ? SYSTEM_PROGRAM_DIRECTORIES.linux : [];

type Holder = { apple: boolean; exact: boolean; unsafe: boolean; program: string };

const searchPathDelimiterOf = (platform: NodeJS.Platform): string => (platform === 'win32' ? path.win32.delimiter : path.posix.delimiter);

export const programOnSearchPath =
  (platform: NodeJS.Platform, holds: ProgramHolds) =>
  async (name: string, cwd: string, searchPath: string | undefined, isWritable: WritableCheck): Promise<ProgramResolution> => {
    if (searchPath === undefined) return { none: true };
    const system = systemProgramDirectories(platform);
    const holderAt = async (entry: string, unsafeBefore: boolean): Promise<Holder | undefined> => {
      const directory = path.resolve(cwd, entry);
      if (!(await holds(directory, name))) return undefined;
      const absolute = path.isAbsolute(entry);
      return {
        apple: system.includes(directory),
        exact: absolute && system.includes(entry),
        unsafe: unsafeBefore || !absolute || (await isWritable(entry)),
        program: path.join(directory, name),
      };
    };
    const entries = searchPath.split(searchPathDelimiterOf(platform));
    let unsafeBefore = false;
    for (const [index, entry] of entries.entries()) {
      const landing = await holderAt(entry, unsafeBefore);
      if (landing !== undefined) {
        if (landing.apple) return landing.exact && !landing.unsafe ? { program: landing.program } : { none: true };
        if (!landing.unsafe) return { program: landing.program };
        for (const later of entries.slice(index + 1)) {
          if ((await holderAt(later, true))?.exact === true) return { none: true };
        }
        return { program: landing.program };
      }
      unsafeBefore = unsafeBefore || !path.isAbsolute(entry) || (await isWritable(entry));
    }
    return { none: true };
  };
