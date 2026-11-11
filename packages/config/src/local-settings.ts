import path from 'node:path';
import { anchorFormOf, sha256Hex } from '@momonga/foundation';
import { asked } from './asker.ts';
import type { Asker } from './asker.ts';
import { isAbsentPathError } from './json-file.ts';
import { layoutOf } from './layout.ts';
import { checkRuleText, isPathTool, NEGATION_PREFIX } from './rule.ts';

const WORKTREE_MARKER = '.git';

export const pathExists = async (file: string, asker: Asker): Promise<boolean> => {
  try {
    await asked(asker, asker.files.access(file, 'exists'));
    return true;
  } catch (error) {
    if (isAbsentPathError(error)) return false;
    throw error;
  }
};

export const worktreeRootOf = async (home: string, projectDir: string, asker: Asker): Promise<string> => {
  const start = await asked(asker, asker.files.realpath(projectDir));
  const realHome = await asked(asker, asker.files.realpath(home));
  for (let current = start; current !== realHome; current = path.dirname(current)) {
    if (await pathExists(path.join(current, WORKTREE_MARKER), asker)) return current;
    if (path.dirname(current) === current) break;
  }
  return start;
};

export const localSettingsDirectory = async (home: string, projectDir: string, asker: Asker): Promise<string> =>
  path.join(layoutOf(home).projects, sha256Hex(await worktreeRootOf(home, projectDir, asker)));

export const localSettingsFile = async (home: string, projectDir: string, asker: Asker): Promise<string> =>
  path.join(await localSettingsDirectory(home, projectDir, asker), 'settings.local.json');

export const reRootedRule = (rule: string, launchDirectory: string, worktreeRoot: string): string => {
  const { tool, specifier } = checkRuleText(rule);
  if (specifier === undefined || !isPathTool(tool) || specifier.startsWith(NEGATION_PREFIX)) return rule;
  const offset = path.relative(worktreeRoot, launchDirectory).split(path.sep).join('/');
  if (offset === '') return rule;
  const form = anchorFormOf(specifier);
  if (form === 'relative') {
    const text = specifier === '.' ? '' : specifier.startsWith('./') ? specifier.slice(2) : specifier;
    return `${tool}(./${path.posix.join(offset, text)})`;
  }
  if (form === 'settings') return `${tool}(/${path.posix.join(offset, specifier.slice(1))})`;
  return rule;
};
