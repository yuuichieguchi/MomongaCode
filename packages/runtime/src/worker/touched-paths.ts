import path from 'node:path';
import type { TouchedPath } from '@momonga/context';
import type { RunState } from '@momonga/protocol';
import { isRecord, parseJsonOrText } from './json.ts';

const FILE_TOOLS = ['Read', 'Write', 'Edit'] as const;
const DIRECTORY_TOOLS = ['Glob', 'Grep'] as const;

const stringField = (args: unknown, key: string): string | undefined => {
  if (!isRecord(args)) return undefined;
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

export const touchedPathsOf = (history: RunState['history'], cwd: string): TouchedPath[] => {
  const touched = new Map<string, TouchedPath>();
  const touch = (target: string, kind: TouchedPath['kind']): void => {
    const resolved = path.resolve(cwd, target);
    touched.set(`${kind}:${resolved}`, { path: resolved, kind });
  };
  for (const { item } of history) {
    if (item.type !== 'function_call') continue;
    const args = parseJsonOrText(item.arguments);
    if (FILE_TOOLS.some((name) => name === item.name)) {
      const target = stringField(args, 'file_path');
      if (target !== undefined) touch(target, 'file');
    } else if (DIRECTORY_TOOLS.some((name) => name === item.name)) {
      touch(stringField(args, 'path') ?? cwd, 'directory');
    } else if (item.name === 'Bash') {
      touch(cwd, 'directory');
    }
  }
  return [...touched.values()];
};
