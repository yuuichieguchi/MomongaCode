import { isRecord } from '@momonga/foundation';
import { editUserSettings } from './edit-user-settings.ts';
import type { EditUserSettingsOptions } from './edit-user-settings.ts';
import type { ResolvedTuiSettings } from './settings.ts';

export const writeTuiSetting = async <Name extends keyof ResolvedTuiSettings>(
  home: string,
  settingsFile: string,
  name: Name,
  value: ResolvedTuiSettings[Name],
  options: EditUserSettingsOptions,
): Promise<void> => {
  await editUserSettings(
    home,
    settingsFile,
    (document) => {
      const existing = document['tui'];
      if (existing !== undefined && !isRecord(existing)) throw new Error(`${settingsFile}: tui must be a JSON object`);
      if (existing?.[name] === value) return false;
      document['tui'] = { ...existing, [name]: value };
      return true;
    },
    options,
  );
};
