import fs from 'node:fs';
import path from 'node:path';
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

export const writeSkillFile = async (options: { root: string; name: string; text: string }): Promise<SkillWrite> => {
  const { root, name, text } = options;
  try {
    if (!(await fs.promises.lstat(root)).isDirectory()) return { kind: 'root_missing', path: root };
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { kind: 'root_missing', path: root };
    throw error;
  }
  const segments = [...SKILL_DIRECTORY_SEGMENTS.native.split(path.sep), name];
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if ((await fs.promises.lstat(current)).isSymbolicLink()) return { kind: 'symlink', path: current };
    } catch (error) {
      if (hasCode(error, 'ENOENT')) break;
      throw error;
    }
  }
  const directory = path.join(root, ...segments);
  await fs.promises.mkdir(directory, { recursive: true });
  const file = path.join(directory, SKILL_FILE_NAME);
  try {
    await fs.promises.writeFile(file, skillFileText(name, text), { flag: 'wx' });
  } catch (error) {
    if (hasCode(error, 'EEXIST')) return { kind: 'exists', path: file };
    throw error;
  }
  return { kind: 'written', path: file };
};
