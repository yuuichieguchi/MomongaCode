import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach } from 'vitest';
import { createTempDir } from '@momonga/testkit';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

export const registerCleanup = (cleanup: () => void): void => {
  cleanups.push(cleanup);
};

export const makeDir = (): string => {
  const dir = createTempDir();
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

export type FlatModel = Record<string, unknown>;

export const connectionOf = (provider: string, flat: FlatModel): Record<string, unknown> => {
  const { model, capabilities, toolCalling, ...connection } = flat;
  return {
    ...connection,
    provider,
    models: [{ id: model ?? `${provider}-model`, ...(capabilities === undefined ? {} : { capabilities }), ...(toolCalling === undefined ? {} : { toolCalling }) }],
  };
};

export const connectionsOf = (flatByProvider: Record<string, FlatModel>): Record<string, unknown>[] => Object.entries(flatByProvider).map(([provider, flat]) => connectionOf(provider, flat));

type ResolvedModelLike = Record<string, unknown> & { canon: string; provider: string; ownName: string; model: string };

type ModelsLike = { models: ReadonlyMap<string, unknown> };

export const resolvedModels = (settings: { models: unknown }): ResolvedModelLike[] => [...(settings.models as ModelsLike).models.values()] as ResolvedModelLike[];

export const modelOf = (settings: { models: unknown }, provider: string): ResolvedModelLike => {
  const found = resolvedModels(settings).find((model) => model.provider === provider);
  if (found === undefined) throw new Error(`no model of the server ${provider} is resolved`);
  return found;
};

export const canonsOf = (settings: { models: unknown }): string[] => [...(settings.models as ModelsLike).models.keys()];
