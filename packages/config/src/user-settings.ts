import fs from 'node:fs';
import { isTransientErrno, nodeFileSystemSync } from '@momonga/foundation';
import { ConfigError, rethrowIfTransient, toConfigError } from './config-error.ts';
import type { JsonFile } from './json-file.ts';
import { createKeptSettings, diskKeptRecords, keptSettingsDirectory } from './kept-settings.ts';
import type { KeptRecords, KeptSettings } from './kept-settings.ts';
import { keptOrThrow } from './last-good.ts';
import type { Kept } from './last-good.ts';
import { layoutOf } from './layout.ts';
import { readUserJsonFile, readUserLayer, userLayerFrom, userSettingsFile } from './layers.ts';
import type { UserLayer } from './layers.ts';
import { mergeLayers, parseLayerRules } from './load-settings.ts';
import type { ResolvedSettings } from './load-settings.ts';
import type { ResolvedModels } from './models.ts';
import type { ModelsSettings, SandboxSetting } from './settings.ts';

export type LoadUserSettingsOptions = { home: string };

export type LoadUserSettingsResult = { settings: ResolvedSettings; warnings: string[]; files: string[] };

type UserSettingsLoad = { settings: ResolvedSettings; user: UserLayer; warnings: string[] };

const userSettingsFrom = (home: string, read: JsonFile): UserSettingsLoad => {
  try {
    const user = userLayerFrom(home, read);
    const warnings = [...user.warnings];
    const layers = user.layer === undefined ? [] : [user.layer];
    for (const layer of layers) parseLayerRules(layer, home, home, warnings);
    const settings = mergeLayers(layers, user.models, home, home, warnings);
    return { settings, user, warnings };
  } catch (error) {
    rethrowIfTransient(error);
    throw toConfigError(error);
  }
};

const loadUserSettingsSync = (home: string): LoadUserSettingsResult => {
  const { settings, user, warnings } = userSettingsFrom(home, readUserJsonFile(home));
  return { settings, warnings, files: user.layer === undefined ? [] : [user.layer.source] };
};

export type UserModels = { declared: ModelsSettings; resolved: ResolvedModels; sandbox?: SandboxSetting; autoModeClassifier?: string };

export const loadUserModels = ({ home }: LoadUserSettingsOptions): UserModels => {
  try {
    const user = readUserLayer(home);
    const sandbox = user.layer?.settings.sandbox;
    const autoModeClassifier = user.layer?.settings.autoMode?.classifier;
    return {
      declared: user.layer?.settings.models ?? {},
      resolved: user.models,
      ...(sandbox === undefined ? {} : { sandbox }),
      ...(autoModeClassifier === undefined ? {} : { autoModeClassifier }),
    };
  } catch (error) {
    rethrowIfTransient(error);
    throw toConfigError(error);
  }
};

export const loadUserSettings = async ({ home }: LoadUserSettingsOptions): Promise<LoadUserSettingsResult> => loadUserSettingsSync(home);

export type UserSettingsCacheOptions = { home: string; onWarning: (message: string) => void; keptRecords?: KeptRecords };

export type UserSettingsLoaded = { settings: ResolvedSettings; user: UserLayer };

export type UserSettingsSnapshot = UserSettingsLoaded | { error: ConfigError };

export type UserSettingsCache = {
  get(): ResolvedSettings;
  read(): UserSettingsLoaded;
  snapshot(): UserSettingsSnapshot;
  kept: KeptSettings;
};

const changeKeyOf = (file: string): string => {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.mtimeNs}:${stat.size}:${stat.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
};

export const userSettingsChangeKey = (home: string): string => changeKeyOf(layoutOf(home).settingsFile);

export const createUserSettingsCache = ({ home, onWarning, keptRecords }: UserSettingsCacheOptions): UserSettingsCache => {
  const file = userSettingsFile(home);
  const kept = createKeptSettings({ records: keptRecords ?? diskKeptRecords(nodeFileSystemSync, keptSettingsDirectory(home)), onWarning });
  let latest: UserSettingsSnapshot | undefined;
  let lastGood: Kept<UserSettingsLoaded>;
  let seenKey: string | undefined;
  let failedKey = '';

  const keptCopy = (): Kept<UserSettingsLoaded> => {
    if (lastGood !== undefined) return lastGood;
    const recalled = kept.recall(file);
    if (recalled === undefined) return undefined;
    const rebuilt = userSettingsFrom(home, recalled.value);
    lastGood = { value: { settings: rebuilt.settings, user: rebuilt.user } };
    return lastGood;
  };

  const failWith = (error: ConfigError, key: string | undefined): void => {
    latest = { error };
    failedKey = key ?? '';
    if (keptCopy() !== undefined) kept.report(file, error, failedKey);
  };

  const refresh = (): UserSettingsSnapshot => {
    let key: string;
    try {
      key = userSettingsChangeKey(home);
    } catch (error) {
      seenKey = undefined;
      rethrowIfTransient(error);
      failWith(toConfigError(error), undefined);
      return latest as UserSettingsSnapshot;
    }
    if (latest !== undefined && !('error' in latest) && key === seenKey) return latest;
    seenKey = key;
    try {
      const read = readUserJsonFile(home);
      const loaded = userSettingsFrom(home, read);
      for (const warning of loaded.warnings) onWarning(warning);
      kept.remember(file, read);
      const current = { settings: loaded.settings, user: loaded.user };
      latest = current;
      lastGood = { value: current };
    } catch (error) {
      if (isTransientErrno(error)) seenKey = undefined;
      rethrowIfTransient(error);
      failWith(toConfigError(error), key);
    }
    return latest as UserSettingsSnapshot;
  };

  const read = (): UserSettingsLoaded => {
    let snapshot: UserSettingsSnapshot;
    try {
      snapshot = refresh();
    } catch (error) {
      if (!isTransientErrno(error)) throw error;
      return keptOrThrow('read', lastGood, error);
    }
    if (!('error' in snapshot)) return snapshot;
    const copy = keptOrThrow('read', keptCopy(), snapshot.error);
    const notice = kept.report(file, snapshot.error, failedKey);
    return { settings: copy.settings, user: { ...copy.user, warnings: [...copy.user.warnings, notice] } };
  };

  return {
    get: () => read().settings,
    read,
    snapshot: refresh,
    kept,
  };
};

export { ConfigError };
