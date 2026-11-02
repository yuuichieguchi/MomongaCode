import fs from 'node:fs/promises';

export type DirectoryEntry =
  | { name: string; kind: 'file' | 'directory' | 'other' }
  | { name: string; kind: 'unreadable'; error: UnreadablePathError };

export type SkillFileSystem = {
  listDirectory(directory: string): Promise<DirectoryEntry[] | undefined>;
  readText(file: string): Promise<string | undefined>;
  realpath(target: string): Promise<string | undefined>;
};

export class UnreadablePathError extends Error {
  readonly path: string;
  readonly code: string;

  constructor(path: string, code: string, cause: unknown) {
    super(`${path} cannot be read (${code})`, { cause });
    this.name = 'UnreadablePathError';
    this.path = path;
    this.code = code;
  }
}

const ABSENT_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);
const UNREADABLE_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG']);

const codeOf = (error: unknown): string | undefined => (error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined);

const isAbsent = (error: unknown): boolean => {
  const code = codeOf(error);
  return code !== undefined && ABSENT_CODES.has(code);
};

const isUnreadable = (error: unknown): boolean => {
  const code = codeOf(error);
  return code !== undefined && UNREADABLE_CODES.has(code);
};

const absentAs = async <T>(path: string, action: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await action();
  } catch (error) {
    if (isAbsent(error)) return undefined;
    const code = codeOf(error);
    if (code !== undefined && isUnreadable(error)) throw new UnreadablePathError(path, code, error);
    throw error;
  }
};

export type ReadAttempt<T> = { kind: 'read'; value: T } | { kind: 'unreadable'; error: UnreadablePathError };

export const attemptRead = async <T>(action: () => Promise<T>): Promise<ReadAttempt<T>> => {
  try {
    return { kind: 'read', value: await action() };
  } catch (error) {
    if (error instanceof UnreadablePathError) return { kind: 'unreadable', error };
    throw error;
  }
};

export const describeUnreadable = (error: UnreadablePathError): string => `${error.path} cannot be read (${error.code})`;

type ReadableKind = 'file' | 'directory' | 'other';

const kindOf = (stats: { isFile(): boolean; isDirectory(): boolean }): ReadableKind => (stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other');

const linkEntryOf = async (name: string, target: string): Promise<DirectoryEntry> => {
  try {
    return { name, kind: kindOf(await fs.stat(target)) };
  } catch (error) {
    if (isAbsent(error)) return { name, kind: 'other' };
    const code = codeOf(error);
    if (code !== undefined && isUnreadable(error)) return { name, kind: 'unreadable', error: new UnreadablePathError(target, code, error) };
    throw error;
  }
};

export const createNodeSkillFileSystem = (): SkillFileSystem => ({
  listDirectory: (directory) =>
    absentAs(directory, async () => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      return Promise.all(
        entries.map(async (entry): Promise<DirectoryEntry> => {
          if (!entry.isSymbolicLink()) return { name: entry.name, kind: kindOf(entry) };
          return linkEntryOf(entry.name, `${directory}/${entry.name}`);
        }),
      );
    }),
  readText: (file) => absentAs(file, () => fs.readFile(file, 'utf8')),
  realpath: (target) => absentAs(target, () => fs.realpath(target)),
});
