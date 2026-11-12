import path from 'node:path';
import type { FileSystem } from '@momonga/foundation';
import { DESCRIPTION_MAX_LENGTH, SKILL_DIRECTORY_SEGMENTS, SKILL_FILE_NAME } from '@momonga/skills';

export type SkillWrite =
  | { kind: 'written'; path: string }
  | { kind: 'exists'; path: string }
  | { kind: 'root_missing'; path: string }
  | { kind: 'symlink'; path: string };

const hasCode = (error: unknown, code: string): boolean => error instanceof Error && 'code' in error && error.code === code;

export const skillDescriptionOf = (text: string): string => {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  return firstLine.trim().slice(0, DESCRIPTION_MAX_LENGTH);
};

export const skillFileText = (name: string, text: string): string =>
  ['---', `name: ${name}`, `description: ${JSON.stringify(skillDescriptionOf(text))}`, '---', text, ''].join('\n');

export type SkillFileSystem = Pick<FileSystem, 'lstat' | 'mkdir' | 'open'>;

export const writeSkillFile = async (fileSystem: SkillFileSystem, options: { root: string; name: string; text: string }): Promise<SkillWrite> => {
  const { root, name, text } = options;
  try {
    if (!(await fileSystem.lstat(root)).isDirectory()) return { kind: 'root_missing', path: root };
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { kind: 'root_missing', path: root };
    throw error;
  }
  const segments = [...SKILL_DIRECTORY_SEGMENTS.native.split(path.sep), name];
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if ((await fileSystem.lstat(current)).isSymbolicLink()) return { kind: 'symlink', path: current };
    } catch (error) {
      if (hasCode(error, 'ENOENT')) break;
      throw error;
    }
  }
  const directory = path.join(root, ...segments);
  await fileSystem.mkdir(directory);
  const file = path.join(directory, SKILL_FILE_NAME);
  let handle: Awaited<ReturnType<SkillFileSystem['open']>>;
  try {
    handle = await fileSystem.open(file, 'wx');
  } catch (error) {
    if (hasCode(error, 'EEXIST')) return { kind: 'exists', path: file };
    throw error;
  }
  try {
    await handle.writeFile(skillFileText(name, text));
  } finally {
    await handle.close();
  }
  return { kind: 'written', path: file };
};
