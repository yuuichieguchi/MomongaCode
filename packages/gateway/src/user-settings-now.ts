import type { ResolvedSettings } from '@momonga/config';

export type SettingsNowOptions = {
  initial: ResolvedSettings;
  initialKey: string;
  changeKey: () => string;
  load: () => ResolvedSettings;
  warn: (message: string) => void;
};

export const createSettingsNow = (options: SettingsNowOptions): (() => ResolvedSettings) => {
  let current = options.initial;
  let seenKey = options.initialKey;
  return () => {
    const key = options.changeKey();
    if (key === seenKey) return current;
    try {
      current = options.load();
      seenKey = key;
    } catch (error) {
      options.warn(`the user settings could not be read again (${error instanceof Error ? error.message : String(error)}); the values last read are used`);
    }
    return current;
  };
};
