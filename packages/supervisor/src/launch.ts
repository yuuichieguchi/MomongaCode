import type { UserSettingsCache, UserSettingsSnapshot } from '@momonga/config';
import type { JsonLogger } from '@momonga/foundation';
import type { ChildManager } from './child-manager.ts';
import { orphansReaped, settingsReadFailed, writeEvent } from './log-events.ts';
import { reapOrphans } from './orphans.ts';
import type { OrphanReapOptions } from './orphans.ts';
import { safeChangeKey } from './settings-watch.ts';
import type { SettingsWatch } from './settings-watch.ts';

export type LaunchTaskOptions = {
  signal: AbortSignal;
  logger: JsonLogger;
  reap: OrphanReapOptions;
  settings: UserSettingsCache;
  changeKey(): string;
  gateway: ChildManager;
  runtime: ChildManager;
  enterRunning(): void;
  startWatch(initialKey: string): SettingsWatch | undefined;
  evaluate(): void;
};

type SettingsRead = { initialKey: string; snapshot: UserSettingsSnapshot } | { initialKey: string; failure: unknown };

const readSettings = (options: LaunchTaskOptions): SettingsRead => {
  let initialKey: string | undefined;
  try {
    initialKey = options.changeKey();
    return { initialKey, snapshot: options.settings.snapshot() };
  } catch (failure) {
    return {
      initialKey:
        initialKey ??
        safeChangeKey(() => {
          throw failure;
        }),
      failure,
    };
  }
};

export const runLaunchTask = async (options: LaunchTaskOptions): Promise<void> => {
  const { signal, logger, gateway, runtime } = options;
  if (signal.aborted) return;
  const reaped = await reapOrphans(options.reap);
  writeEvent(logger, orphansReaped({ reaped: reaped.reaped, kept: reaped.kept }));
  if (signal.aborted) return;

  const read = readSettings(options);
  if ('failure' in read) {
    const failure = read.failure instanceof Error ? read.failure : new Error(String(read.failure));
    writeEvent(logger, settingsReadFailed({ detail: failure.message }, failure));
    gateway.failWithoutProcess('settings-read-failed');
    runtime.failWithoutProcess('settings-read-failed');
  } else {
    gateway.spawnWith(read.snapshot, 'initial');
    runtime.spawnWith(read.snapshot, 'initial');
  }
  options.enterRunning();
  if (signal.aborted) return;

  const watch = options.startWatch(read.initialKey);
  if (watch === undefined) return;
  options.evaluate();
};
