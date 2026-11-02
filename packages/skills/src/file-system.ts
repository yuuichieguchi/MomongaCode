import fs from 'node:fs/promises';

export type DirectoryEntry = { name: string; kind: 'file' | 'directory' | 'other' };

export type SkillFileSystem = {
  listDirectory(directory: string): Promise<DirectoryEntry[] | undefined>;
  readText(file: string): Promise<string | undefined>;
  realpath(target: string): Promise<string | undefined>;
};

const ABSENT_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

const isAbsent = (error: unknown): boolean => error instanceof Error && 'code' in error && typeof error.code === 'string' && ABSENT_CODES.has(error.code);

const absentAs = async <T>(action: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await action();
  } catch (error) {
    if (isAbsent(error)) return undefined;
    throw error;
  }
};

const kindOf = (stats: { isFile(): boolean; isDirectory(): boolean }): DirectoryEntry['kind'] => (stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other');

export const createNodeSkillFileSystem = (): SkillFileSystem => ({
  listDirectory: (directory) =>
    absentAs(async () => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      return Promise.all(
        entries.map(async (entry): Promise<DirectoryEntry> => {
          if (!entry.isSymbolicLink()) return { name: entry.name, kind: kindOf(entry) };
          const target = await absentAs(() => fs.stat(`${directory}/${entry.name}`));
          return { name: entry.name, kind: target === undefined ? 'other' : kindOf(target) };
        }),
      );
    }),
  readText: (file) => absentAs(() => fs.readFile(file, 'utf8')),
  realpath: (target) => absentAs(() => fs.realpath(target)),
});
