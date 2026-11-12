import path from 'node:path';
import { answeredLater, canonicalJson, isRecord, systemFileLockPorts } from '@momonga/foundation';
import type { FileLockPorts, KernelLockMechanism } from '@momonga/foundation';
import { askerOf } from './asker.ts';
import type { Asker } from './asker.ts';
import { editUserSettings } from './edit-user-settings.ts';
import { settingsWriterPorts } from './file-lock.ts';
import { appendPermissionRule } from './append-rule.ts';
import { ConfigError, rethrowIfTransient, toConfigError } from './config-error.ts';
import { readJsonFile } from './json-file.ts';
import { repositoryLayerFrom, userSettingsFile } from './layers.ts';
import { mergingLayers, parseLayerRules } from './load-settings.ts';
import type { ResolvedSettings } from './load-settings.ts';
import { localSettingsFile, worktreeRootOf } from './local-settings.ts';
import { projectMcpServersFile } from './mcp-servers.ts';
import type { RuleEffect } from './rule.ts';
import { defaultUserSettings, userDocumentWarnings } from './user-settings.ts';

export type SettingsLayer = 'user' | 'project' | 'local';

export type SettingsPath = readonly string[];

export type SettingsOperation =
  | { readonly kind: 'set'; readonly path: SettingsPath; readonly value: unknown }
  | { readonly kind: 'unset'; readonly path: SettingsPath }
  | { readonly kind: 'update'; readonly path: SettingsPath; update(current: unknown): unknown }
  | { readonly kind: 'addRule'; readonly effect: RuleEffect; readonly rule: string };

export type SettingsPlace = { readonly home: string; readonly projectDir: string };

export type EditSettingsOptions = { lock: KernelLockMechanism; ports?: FileLockPorts; lockTimeoutMs?: number; signal: AbortSignal };

export type SettingsLayerView = { readonly layer: SettingsLayer; readonly file: string; readonly document: Readonly<Record<string, unknown>> };

export type SettingsSnapshot = {
  readonly layers: readonly SettingsLayerView[];
  readonly targets: readonly SettingsLayer[];
  readonly defaults: ResolvedSettings;
  readonly mcpFile: string | undefined;
};

type Located = { readonly file: string; readonly root: string };

const configError = async <T>(work: () => Promise<T>, { signal }: Asker): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    rethrowIfTransient(error);
    throw toConfigError(error);
  }
};

const isHome = ({ home, projectDir }: SettingsPlace): boolean => path.resolve(projectDir) === path.resolve(home);

const locate = async (place: SettingsPlace, layer: SettingsLayer, asker: Asker): Promise<Located> => {
  if (layer === 'user') return { file: userSettingsFile(place.home), root: place.home };
  if (isHome(place)) throw new ConfigError(`${place.projectDir} is the home directory; it has no ${layer} settings`);
  if (layer === 'project') return { file: path.join(place.projectDir, '.momonga', 'settings.json'), root: place.projectDir };
  return { file: await localSettingsFile(place.home, place.projectDir, asker), root: await worktreeRootOf(place.home, place.projectDir, asker) };
};

const loaderWarnings = async (place: SettingsPlace, layer: SettingsLayer, located: Located, document: unknown, asker: Asker): Promise<string[]> => {
  if (layer === 'user') return userDocumentWarnings(place.home, document, asker);
  try {
    const warnings: string[] = [];
    const built = repositoryLayerFrom(document, located.file, layer, located.root, warnings);
    if (built === undefined) return warnings;
    parseLayerRules(built, place.home, place.projectDir, warnings);
    const { models } = await defaultUserSettings(place.home, asker);
    await answeredLater(mergingLayers([built], models, place.home, place.projectDir, warnings), asker.paths, asker.signal);
    return warnings;
  } catch (error) {
    if (asker.signal.aborted) throw asker.signal.reason;
    rethrowIfTransient(error);
    throw toConfigError(error);
  }
};

type WrittenLoad = { readonly loads: true; readonly warnings: readonly string[] } | { readonly loads: false };

const writtenLoadOf = async (place: SettingsPlace, layer: SettingsLayer, located: Located, document: unknown, asker: Asker): Promise<WrittenLoad> => {
  try {
    return { loads: true, warnings: await loaderWarnings(place, layer, located, document, asker) };
  } catch (error) {
    if (error instanceof ConfigError) return { loads: false };
    throw error;
  }
};

const discardedByLoader = (written: WrittenLoad, result: readonly string[]): string | undefined => (written.loads ? result.find((warning) => !written.warnings.includes(warning)) : undefined);

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

export const editSettings = async (settingsPlace: SettingsPlace, layer: SettingsLayer, operation: SettingsOperation, options: EditSettingsOptions): Promise<void> => {
  const asker = askerOf(options.signal);
  const located = await configError(() => locate(settingsPlace, layer, asker), asker);
  if (layer === 'local' && operation.kind === 'addRule') {
    await configError(
      () =>
        appendPermissionRule({
          home: settingsPlace.home,
          projectDir: settingsPlace.projectDir,
          rule: operation.rule,
          effect: operation.effect,
        lock: options.lock,
          ports: options.ports ?? systemFileLockPorts,
          signal: options.signal,
          ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
        }),
      asker,
    );
    return;
  }
  await editUserSettings(
    located.file,
    async (document) => {
      const before = canonicalJson(document);
      const written = await writtenLoadOf(settingsPlace, layer, located, document, asker);
      apply(document, located.file, operation);
      if (canonicalJson(document) === before) return false;
      const refusal = discardedByLoader(written, await loaderWarnings(settingsPlace, layer, located, document, asker));
      if (refusal !== undefined) throw new ConfigError(refusal);
      return true;
    },
    settingsWriterPorts(settingsPlace.home, options),
  );
};

const documentOf = async (file: string, asker: Asker): Promise<Record<string, unknown>> => {
  const read = await readJsonFile(file, asker);
  if (!read.found) return {};
  if (!isRecord(read.value)) throw new ConfigError(`${file}: settings must be a JSON object`);
  return read.value;
};

export type SettingsSnapshotRequest = SettingsPlace & { readonly trusted: boolean; readonly signal: AbortSignal };

export const readSettingsSnapshot = async (settingsPlace: SettingsSnapshotRequest): Promise<SettingsSnapshot> => {
  const asker = askerOf(settingsPlace.signal);
  return configError(async () => {
    const repository = !isHome(settingsPlace);
    const shown: SettingsLayer[] = ['user', ...(repository && settingsPlace.trusted ? (['project'] as const) : []), ...(repository ? (['local'] as const) : [])];
    const layers: SettingsLayerView[] = [];
    for (const layer of shown) {
      const { file } = await locate(settingsPlace, layer, asker);
      layers.push({ layer, file, document: await documentOf(file, asker) });
    }
    return {
      layers,
      targets: shown,
      defaults: await defaultUserSettings(settingsPlace.home, asker),
      mcpFile: repository ? projectMcpServersFile(settingsPlace.projectDir) : undefined,
    };
  }, asker);
};
