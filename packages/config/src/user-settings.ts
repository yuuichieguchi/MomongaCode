import fs from 'node:fs';
import { isTransientErrno } from '@momonga/foundation';
import { ConfigError, rethrowIfTransient, toConfigError } from './config-error.ts';
import { layoutOf } from './layout.ts';
import { readUserLayer } from './layers.ts';
import type { UserLayer } from './layers.ts';
import { mergeLayers } from './load-settings.ts';
import type { ResolvedSettings } from './load-settings.ts';

export type LoadUserSettingsOptions = { home: string };

export type LoadUserSettingsResult = { settings: ResolvedSettings; warnings: string[]; files: string[] };

type UserSettingsLoad = { settings: ResolvedSettings; user: UserLayer; warnings: string[] };

const readUserSettingsSync = (home: string): UserSettingsLoad => {
  try {
    const user = readUserLayer(home);
    const warnings = [...user.warnings];
    const layers = user.layer === undefined ? [] : [user.layer];
    const settings = mergeLayers(layers, user.models, home, home, warnings);
    return { settings, user, warnings };
  } catch (error) {
    rethrowIfTransient(error);
    throw toConfigError(error);
  }
};

const loadUserSettingsSync = (home: string): LoadUserSettingsResult => {
  const { settings, user, warnings } = readUserSettingsSync(home);
  return { settings, warnings, files: user.layer === undefined ? [] : [user.layer.source] };
};

export const loadUserSettings = async ({ home }: LoadUserSettingsOptions): Promise<LoadUserSettingsResult> => loadUserSettingsSync(home);

export type UserSettingsCacheOptions = { home: string; onWarning: (message: string) => void };

export type UserSettingsSnapshot = { settings: ResolvedSettings; user: UserLayer } | { error: ConfigError };

export type UserSettingsCache = {
  get(): ResolvedSettings;
  snapshot(): UserSettingsSnapshot;
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

export const createUserSettingsCache = ({ home, onWarning }: UserSettingsCacheOptions): UserSettingsCache => {
  let latest: UserSettingsSnapshot | undefined;
  let lastGood: ResolvedSettings | undefined;
  let seenKey: string | undefined;

  let warnedFailure: string | undefined;

  const failWith = (error: ConfigError, key: string | undefined): void => {
    latest = { error };
    const failure = `${key}\u0000${error.message}`;
    if (lastGood === undefined || failure === warnedFailure) return;
    warnedFailure = failure;
    onWarning(`settings file is invalid: ${error.message}`);
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
      const loaded = readUserSettingsSync(home);
      for (const warning of loaded.warnings) onWarning(warning);
      lastGood = loaded.settings;
      warnedFailure = undefined;
      latest = { settings: loaded.settings, user: loaded.user };
    } catch (error) {
      if (isTransientErrno(error)) seenKey = undefined;
      rethrowIfTransient(error);
      failWith(toConfigError(error), key);
    }
    return latest as UserSettingsSnapshot;
  };

  return {
    get: () => {
      let snapshot: UserSettingsSnapshot;
      try {
        snapshot = refresh();
      } catch (error) {
        if (isTransientErrno(error) && lastGood !== undefined) return lastGood;
        throw error;
      }
      if (!('error' in snapshot)) return snapshot.settings;
      if (lastGood === undefined) throw snapshot.error;
      return lastGood;
    },
    snapshot: refresh,
  };
};

export { ConfigError };
