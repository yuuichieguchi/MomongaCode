import { isRecord } from '@momonga/foundation';
import { editUserSettings } from './edit-user-settings.ts';
import { settingsWriterPorts } from './file-lock.ts';
import type { SettingsWriterOptions } from './file-lock.ts';

export const writeMemoryAutoReview = async (home: string, settingsFile: string, value: boolean, options: SettingsWriterOptions): Promise<void> => {
  await editUserSettings(
    settingsFile,
    (document) => {
      const existing = document['memory'];
      if (existing !== undefined && !isRecord(existing)) throw new Error(`${settingsFile}: memory must be a JSON object`);
      if (existing?.['autoReview'] === value) return false;
      document['memory'] = { ...existing, autoReview: value };
      return true;
    },
    settingsWriterPorts(home, options),
  );
};
