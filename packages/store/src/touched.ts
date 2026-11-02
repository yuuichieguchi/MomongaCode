import { parseJsonOrText } from '@momonga/foundation';
import type { InputItem, TouchedTarget } from '@momonga/protocol';
import { isRecord } from './rows.ts';

const FILE_TOOLS: readonly string[] = ['Read', 'Write', 'Edit'];
const DIRECTORY_TOOLS: readonly string[] = ['Glob', 'Grep'];

const stringField = (args: unknown, key: string): string | undefined => {
  if (!isRecord(args)) return undefined;
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

export const touchedTargetOf = (item: InputItem): TouchedTarget | undefined => {
  if (item.type !== 'function_call') return undefined;
  const args = parseJsonOrText(item.arguments);
  if (FILE_TOOLS.includes(item.name)) {
    const target = stringField(args, 'file_path');
    return target === undefined ? undefined : { kind: 'file', path: target };
  }
  if (DIRECTORY_TOOLS.includes(item.name)) {
    const target = stringField(args, 'path');
    return target === undefined ? { kind: 'directory' } : { kind: 'directory', path: target };
  }
  if (item.name === 'Bash') return { kind: 'directory' };
  return undefined;
};
