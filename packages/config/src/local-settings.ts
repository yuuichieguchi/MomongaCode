import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { anchorFormOf, sha256Hex } from '@momonga/foundation';
import { layoutOf } from './layout.ts';
import { checkRuleText, isPathTool, NEGATION_PREFIX } from './rule.ts';

const realpath = promisify(fs.realpath.native);

const WORKTREE_MARKER = '.git';

export const worktreeRootOf = async (home: string, projectDir: string): Promise<string> => {
  const start = await realpath(projectDir);
  const realHome = await realpath(home);
  for (let current = start; current !== realHome; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, WORKTREE_MARKER))) return current;
    if (path.dirname(current) === current) break;
  }
  return start;
};

export const localSettingsDirectory = async (home: string, projectDir: string): Promise<string> =>
  path.join(layoutOf(home).projects, sha256Hex(await worktreeRootOf(home, projectDir)));

export const localSettingsFile = async (home: string, projectDir: string): Promise<string> =>
  path.join(await localSettingsDirectory(home, projectDir), 'settings.local.json');

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
