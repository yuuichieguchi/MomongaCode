import { hostPaths, isRecord } from '@momonga/foundation';
import type { LayoutEnvironment } from '@momonga/foundation';
import { acceptedCheckOf } from './declared-checks.ts';
import type { AcceptedCheck } from './declared-checks.ts';
import { editUserSettings } from './edit-user-settings.ts';
import type { SettingsWriterPorts } from './file-lock.ts';
import { layoutOf } from './layout.ts';
import { loadUserSettings } from './user-settings.ts';

export const readProjectCheck = async ({ env, home, projectDir, signal }: { env: LayoutEnvironment; home: string; projectDir: string; signal: AbortSignal }): Promise<AcceptedCheck | undefined> =>
  acceptedCheckOf((await loadUserSettings({ env, home, signal })).settings, await hostPaths(signal).canonicalPath(projectDir));

export const forgetProjectCheck = async (home: string, projectDir: string, ports: SettingsWriterPorts): Promise<void> => {
  const folder = await hostPaths(ports.signal).canonicalPath(projectDir);
  await editUserSettings(
    layoutOf(home).settingsFile,
    (settings) => {
      const checks = settings['projectChecks'];
      if (!isRecord(checks) || !Object.hasOwn(checks, folder)) return false;
      const kept: Record<string, unknown> = { ...checks };
      delete kept[folder];
      settings['projectChecks'] = kept;
      return true;
    },
    ports,
  );
};
