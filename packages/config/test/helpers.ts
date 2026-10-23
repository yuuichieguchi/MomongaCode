import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

export const registerCleanup = (cleanup: () => void): void => {
  cleanups.push(cleanup);
};

export const makeDir = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cfg-')));
  fs.chmodSync(dir, 0o700);
  registerCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

export type Tree = { home: string; project: string };

export const makeTree = (): Tree => {
  const root = makeDir();
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(project, { mode: 0o700 });
  return { home, project };
};

export const writeText = (file: string, text: string): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
};

export const writeJson = (file: string, value: unknown): string => writeText(file, JSON.stringify(value, null, 2));

export const userSettingsPath = (tree: Tree): string => path.join(tree.home, '.momonga', 'settings.json');
export const projectSettingsPath = (tree: Tree): string => path.join(tree.project, '.momonga', 'settings.json');
export const localSettingsDir = (tree: Tree): string =>
  path.join(tree.home, '.momonga', 'projects', createHash('sha256').update(fs.realpathSync(tree.project)).digest('hex'));
export const localSettingsPath = (tree: Tree): string => path.join(localSettingsDir(tree), 'settings.local.json');
export const repoLocalSettingsPath = (tree: Tree): string => path.join(tree.project, '.momonga', 'settings.local.json');
export const mcpJsonPath = (tree: Tree): string => path.join(tree.project, '.mcp.json');

export const trusting = (tree: Tree) => ({ isTrusted: (p: string): boolean => fs.realpathSync(p) === fs.realpathSync(tree.project) });
export const distrusting = () => ({ isTrusted: (_p: string): boolean => false });
