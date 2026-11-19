import { loadSettings, loadUserSettings } from '@momonga/config';
import { makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';

export type Chains = ReadonlyMap<string, readonly string[]>;

export type LoadedModels = {
  connections: readonly Record<string, unknown>[];
  models: ReadonlyMap<string, Record<string, unknown>>;
  views: readonly { canon: string; provider: string; ownName: string; defaultTag?: string; naming: string }[];
  chains: Chains;
  start: string | undefined;
  effort?: string;
  efforts: ReadonlyMap<string, string>;
  fallback: readonly string[];
  roles: Record<string, string>;
  billingChanges: readonly { from: string; to: string; model?: string }[];
};

export type Loaded = { tree: Tree; file: string; models: LoadedModels; warnings: string[] };

export const loadFile = async (document: unknown): Promise<Loaded> => {
  const tree = makeTree();
  const file = writeJson(userSettingsPath(tree), document);
  const result = await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal });
  return { tree, file, models: result.settings.models as unknown as LoadedModels, warnings: result.warnings };
};

export const loadModelsSection = (models: unknown): Promise<Loaded> => loadFile({ models });

export const refusalOf = async (document: unknown): Promise<{ file: string; message: string }> => {
  const tree = makeTree();
  const file = writeJson(userSettingsPath(tree), document);
  const error = await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal }).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof Error)) throw new Error('the settings file was accepted');
  return { file, message: error.message };
};

export const sentenceOf = async (document: unknown): Promise<string> => {
  const { file, message } = await refusalOf(document);
  return message.startsWith(`${file}: `) ? message.slice(file.length + 2) : `the message does not start with the file: ${message}`;
};

export const loadWithProject = async (user: unknown, project: unknown) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), user);
  const projectFile = writeJson(projectSettingsPath(tree), project);
  const result = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
  return { tree, projectFile, models: result.settings.models as unknown as LoadedModels, warnings: result.warnings };
};
