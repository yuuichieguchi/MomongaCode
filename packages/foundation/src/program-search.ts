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

export type ProgramOwnerFiles = Pick<FileSystemSync, 'lstatSync' | 'realpathSync'>;

const OTHERS_WRITE = 0o022;
const STICKY = 0o1000;

const ancestorsOf = (file: string): string[] => {
  const chain = [file];
  for (let current = file; path.dirname(current) !== current; current = path.dirname(current)) chain.push(path.dirname(current));
  return chain;
};

const ownedByPersonOrRoot = (uid: number, person: number): boolean => uid === person || uid === 0;

const ownerProblemOfChain = (file: string, files: ProgramOwnerFiles, person: number): string | undefined => {
  const chain = ancestorsOf(file);
  for (const [index, entry] of chain.entries()) {
    const stat = files.lstatSync(entry);
    const ownerText = `${entry} (owner uid ${stat.uid}, mode ${(stat.mode & 0o7777).toString(8)})`;
    if (!ownedByPersonOrRoot(stat.uid, person)) return `${ownerText} is owned by another account`;
    if (stat.isSymbolicLink() || stat.uid === person || (stat.mode & OTHERS_WRITE) === 0) continue;
    const below = index === 0 ? undefined : chain[index - 1];
    const guardedBySticky = stat.isDirectory() && (stat.mode & STICKY) !== 0 && below !== undefined && ownedByPersonOrRoot(files.lstatSync(below).uid, person);
    if (!guardedBySticky) return `${ownerText} can be changed by another account`;
  }
  return undefined;
};

export const programOwnerProblemSync = (file: string, files: ProgramOwnerFiles, person: number): string | undefined => {
  const problem = ownerProblemOfChain(file, files, person) ?? ownerProblemOfChain(files.realpathSync(file), files, person);
  return problem === undefined ? undefined : `${file} is not used: ${problem}; a program run for secrets must be owned by you or root, in folders that only you or root can change`;
};
