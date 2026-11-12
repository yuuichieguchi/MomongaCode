import type { UserSettingsCache, UserSettingsSnapshot } from '@momonga/config';
import type { JsonLogger } from '@momonga/foundation';
import type { ChildManager } from './child-manager.ts';
import { orphansReaped, settingsReadFailed, writeEvent } from './log-events.ts';
import { safeChangeKey } from './settings-watch.ts';
import type { SettingsWatch } from './settings-watch.ts';

export type LaunchTaskOptions = {
  signal: AbortSignal;
  logger: JsonLogger;
  reapOwnMarkers(): Promise<{ reaped: number; kept: number }>;
  settings: UserSettingsCache;
  changeKey(): Promise<string>;
  gateway: ChildManager;
  runtime: ChildManager;
  startWatch(initialKey: string): SettingsWatch | undefined;
  evaluate(): Promise<void>;
};

type SettingsRead = { initialKey: string; snapshot: UserSettingsSnapshot } | { initialKey: string; failure: unknown };

const readSettings = async (options: LaunchTaskOptions): Promise<SettingsRead> => {
  let initialKey: string | undefined;
  try {
    initialKey = await options.changeKey();
    return { initialKey, snapshot: await options.settings.load(options.signal) };
  } catch (failure) {
    return { initialKey: initialKey ?? (await safeChangeKey(() => Promise.reject(failure))), failure };
  }
};

export const runLaunchTask = async (options: LaunchTaskOptions): Promise<void> => {
  const { signal, logger, gateway, runtime } = options;
  if (signal.aborted) return;
  const reaped = await options.reapOwnMarkers();
  writeEvent(logger, orphansReaped({ reaped: reaped.reaped, kept: reaped.kept }));
  if (signal.aborted) return;

  const read = await readSettings(options);
  if (signal.aborted) return;
  if ('failure' in read) {
    const failure = read.failure instanceof Error ? read.failure : new Error(String(read.failure));
    writeEvent(logger, settingsReadFailed({ detail: failure.message }, failure));
    gateway.failWithoutProcess('settings-read-failed');
    runtime.failWithoutProcess('settings-read-failed');
  } else {
    await Promise.all([gateway.spawnWith(read.snapshot, 'initial'), runtime.spawnWith(read.snapshot, 'initial')]);
  }
  if (signal.aborted) return;

  const watch = options.startWatch(read.initialKey);
  if (watch === undefined) return;
  await options.evaluate();
};
