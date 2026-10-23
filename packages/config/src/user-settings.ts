import fs from 'node:fs';
import { layoutOf } from './layout.ts';
import { readUserLayer } from './layers.ts';
import { mergeLayers } from './load-settings.ts';
import type { ResolvedSettings } from './load-settings.ts';

export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigError';
  }
}

export type LoadUserSettingsOptions = { home: string };

export type LoadUserSettingsResult = { settings: ResolvedSettings; warnings: string[]; files: string[] };

const loadUserSettingsSync = (home: string): LoadUserSettingsResult => {
  try {
    const user = readUserLayer(home);
    const warnings = [...user.warnings];
    const layers = user.layer === undefined ? [] : [user.layer];
    const settings = mergeLayers(layers, user.models, home, home, warnings);
    return { settings, warnings, files: layers.map((layer) => layer.source) };
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError((error as Error).message, { cause: error });
  }
};

export const loadUserSettings = async ({ home }: LoadUserSettingsOptions): Promise<LoadUserSettingsResult> => loadUserSettingsSync(home);

export type UserSettingsCacheOptions = { home: string; onWarning: (message: string) => void };

export type UserSettingsCache = { get(): ResolvedSettings };

const changeKeyOf = (file: string): string => {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.mtimeNs}:${stat.size}:${stat.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
};

export const createUserSettingsCache = ({ home, onWarning }: UserSettingsCacheOptions): UserSettingsCache => {
  const file = layoutOf(home).settingsFile;
  let current: ResolvedSettings | undefined;
  let seenKey: string | undefined;
  const reload = (): ResolvedSettings => {
    const loaded = loadUserSettingsSync(home);
    for (const warning of loaded.warnings) onWarning(warning);
    return loaded.settings;
  };
  return {
    get: () => {
      const key = changeKeyOf(file);
      if (current === undefined) {
        current = reload();
        seenKey = key;
        return current;
      }
      if (key === seenKey) return current;
      seenKey = key;
      try {
        current = reload();
      } catch (error) {
        onWarning(`${(error as Error).message}; keeping the last good settings`);
      }
      return current;
    },
  };
};
