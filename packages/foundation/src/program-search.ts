import path from 'node:path';
import type { FileSystem, FileSystemSync } from './node-file-system.ts';

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
