import { isRecord } from '@momonga/foundation';
import { acceptedCheckOf } from './declared-checks.ts';
import type { AcceptedCheck } from './declared-checks.ts';
import { editUserSettings } from './edit-user-settings.ts';
import { settingsWriterPorts } from './file-lock.ts';
import type { SettingsWriterOptions } from './file-lock.ts';
import { loadUserSettings } from './user-settings.ts';

export const readProjectCheck = async (home: string, projectReal: string, signal: AbortSignal): Promise<AcceptedCheck | undefined> =>
  acceptedCheckOf((await loadUserSettings({ home, signal })).settings, projectReal);

export const writeProjectCheck = async (home: string, settingsFile: string, projectReal: string, answer: AcceptedCheck | undefined, options: SettingsWriterOptions): Promise<void> => {
  await editUserSettings(
    settingsFile,
    (document) => {
      const existing = document['projectChecks'];
      if (existing !== undefined && !isRecord(existing)) throw new Error(`${settingsFile}: projectChecks must be a JSON object`);
      const checks: Record<string, unknown> = { ...existing };
      if (answer === undefined) {
        if (!Object.hasOwn(checks, projectReal)) return false;
        delete checks[projectReal];
      } else {
        checks[projectReal] = 'declined' in answer ? { declined: true } : { commands: [...answer.commands] };
      }
      document['projectChecks'] = checks;
      return true;
    },
    settingsWriterPorts(home, options),
  );
};
