import path from 'node:path';
import { canonicalJson, isRecord, systemFileLockPorts } from '@momonga/foundation';
import type { FileLockPorts } from '@momonga/foundation';
import { editUserSettings } from './add-model-connection.ts';
import { appendPermissionRule } from './append-rule.ts';
import { ConfigError, rethrowIfTransient, toConfigError } from './config-error.ts';
import { readJsonFile } from './json-file.ts';
import { repositoryLayerFrom, userLayerFrom, userSettingsFile } from './layers.ts';
import { mergeLayers, parseLayerRules } from './load-settings.ts';
import type { ResolvedSettings } from './load-settings.ts';
import { localSettingsFile, worktreeRootOf } from './local-settings.ts';
import type { RuleEffect } from './rule.ts';
import { userDocumentWarnings } from './user-settings.ts';

export type SettingsLayer = 'user' | 'project' | 'local';

export type SettingsPath = readonly string[];

export type SettingsOperation =
  | { readonly kind: 'set'; readonly path: SettingsPath; readonly value: unknown }
  | { readonly kind: 'unset'; readonly path: SettingsPath }
  | { readonly kind: 'update'; readonly path: SettingsPath; update(current: unknown): unknown }
  | { readonly kind: 'addRule'; readonly effect: RuleEffect; readonly rule: string };

export type SettingsPlace = { readonly home: string; readonly projectDir: string };

export type EditSettingsOptions = { ports?: FileLockPorts; lockTimeoutMs?: number; signal?: AbortSignal };

export type SettingsLayerView = { readonly layer: SettingsLayer; readonly file: string; readonly document: Readonly<Record<string, unknown>> };

export type SettingsSnapshot = {
  readonly layers: readonly SettingsLayerView[];
  readonly targets: readonly SettingsLayer[];
  readonly defaults: ResolvedSettings;
  readonly mcpFile: string | undefined;
};

type Located = { readonly file: string; readonly root: string };

const configError = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    rethrowIfTransient(error);
    throw toConfigError(error);
  }
};

const isHome = ({ home, projectDir }: SettingsPlace): boolean => path.resolve(projectDir) === path.resolve(home);

const locate = async (place: SettingsPlace, layer: SettingsLayer): Promise<Located> => {
  if (layer === 'user') return { file: userSettingsFile(place.home), root: place.home };
  if (isHome(place)) throw new ConfigError(`${place.projectDir} is the home directory; it has no ${layer} settings`);
  if (layer === 'project') return { file: path.join(place.projectDir, '.momonga', 'settings.json'), root: place.projectDir };
  return { file: await localSettingsFile(place.home, place.projectDir), root: await worktreeRootOf(place.home, place.projectDir) };
};

const defaultsOf = (home: string): ResolvedSettings => mergeLayers([], userLayerFrom(home, { found: false }).models, home, home, []);

const loaderWarnings = (place: SettingsPlace, layer: SettingsLayer, located: Located, document: unknown): string[] => {
  if (layer === 'user') return userDocumentWarnings(place.home, document);
  try {
    const warnings: string[] = [];
    const built = repositoryLayerFrom(document, located.file, layer, located.root, warnings);
    if (built === undefined) return warnings;
    parseLayerRules(built, place.home, place.projectDir, warnings);
    mergeLayers([built], defaultsOf(place.home).models, place.home, place.projectDir, warnings);
    return warnings;
  } catch (error) {
    rethrowIfTransient(error);
    throw toConfigError(error);
  }
};

const parentOf = (document: Record<string, unknown>, file: string, keys: SettingsPath): Record<string, unknown> => {
  let current = document;
  keys.forEach((key, index) => {
    const next = current[key];
    if (next !== undefined && !isRecord(next)) throw new ConfigError(`${file}: "${keys.slice(0, index + 1).join('.')}" must be an object`);
    const child = next ?? {};
    current[key] = child;
    current = child;
  });
  return current;
};

const pruneEmpty = (document: Record<string, unknown>, keys: SettingsPath): void => {
  for (let depth = keys.length; depth > 0; depth -= 1) {
    const holder = keys.slice(0, depth - 1).reduce<Record<string, unknown>>((current, key) => current[key] as Record<string, unknown>, document);
    const key = keys[depth - 1] as string;
    const value = holder[key];
    if (!isRecord(value) || Object.keys(value).length > 0) return;
    delete holder[key];
  }
};

const place = (document: Record<string, unknown>, file: string, target: SettingsPath, update: (current: unknown) => unknown): void => {
  const leaf = target.at(-1);
  if (leaf === undefined) throw new ConfigError(`${file}: a setting needs a name`);
  const parents = target.slice(0, -1);
  const holder = parentOf(document, file, parents);
  const next = update(holder[leaf]);
  if (next === undefined) delete holder[leaf];
  else holder[leaf] = next;
  pruneEmpty(document, parents);
};

const withRule = (rule: string) => (current: unknown): unknown => {
  const rules = Array.isArray(current) ? (current as unknown[]) : [];
  return rules.includes(rule) ? rules : [...rules, rule];
};

const apply = (document: Record<string, unknown>, file: string, operation: SettingsOperation): void => {
  switch (operation.kind) {
    case 'set':
      return place(document, file, operation.path, () => operation.value);
    case 'unset':
      return place(document, file, operation.path, () => undefined);
    case 'update':
      return place(document, file, operation.path, (current) => operation.update(current));
    case 'addRule':
      return place(document, file, ['permissions', operation.effect], withRule(operation.rule));
  }
};

export const editSettings = async (settingsPlace: SettingsPlace, layer: SettingsLayer, operation: SettingsOperation, options: EditSettingsOptions = {}): Promise<void> => {
  const located = await configError(() => locate(settingsPlace, layer));
  if (layer === 'local' && operation.kind === 'addRule') {
    await configError(() =>
      appendPermissionRule({
        home: settingsPlace.home,
        projectDir: settingsPlace.projectDir,
        rule: operation.rule,
        effect: operation.effect,
        ports: options.ports ?? systemFileLockPorts,
        ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
      }),
    );
    return;
  }
  await editUserSettings(
    settingsPlace.home,
    located.file,
    (document) => {
      const before = canonicalJson(document);
      const known = loaderWarnings(settingsPlace, layer, located, document);
      apply(document, located.file, operation);
      if (canonicalJson(document) === before) return false;
      const refusal = loaderWarnings(settingsPlace, layer, located, document).find((warning) => !known.includes(warning));
      if (refusal !== undefined) throw new ConfigError(refusal);
      return true;
    },
    options,
  );
};

const documentOf = async (file: string): Promise<Record<string, unknown>> => {
  const read = await readJsonFile(file);
  if (!read.found) return {};
  if (!isRecord(read.value)) throw new ConfigError(`${file}: settings must be a JSON object`);
  return read.value;
};

export const readSettingsSnapshot = async (settingsPlace: SettingsPlace & { readonly trusted: boolean }): Promise<SettingsSnapshot> =>
  configError(async () => {
    const repository = !isHome(settingsPlace);
    const shown: SettingsLayer[] = ['user', ...(repository && settingsPlace.trusted ? (['project'] as const) : []), ...(repository ? (['local'] as const) : [])];
    const layers: SettingsLayerView[] = [];
    for (const layer of shown) {
      const { file } = await locate(settingsPlace, layer);
      layers.push({ layer, file, document: await documentOf(file) });
    }
    return {
      layers,
      targets: repository && settingsPlace.trusted ? ['user', 'project', 'local'] : ['user'],
      defaults: defaultsOf(settingsPlace.home),
      mcpFile: repository ? path.join(settingsPlace.projectDir, '.mcp.json') : undefined,
    };
  });
