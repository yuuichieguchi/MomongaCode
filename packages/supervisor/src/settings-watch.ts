import fs from 'node:fs';
import type { SupervisorTimers } from './constants.ts';

export type SettingsWatch = { stop(): void; idle(): Promise<void> };

export type WatchSettingsOptions = {
  directory: string;
  file: string;
  debounceMs: number;
  pollMs: number;
  changeKey: () => Promise<string>;
  initialKey: string;
  onChange: () => void | Promise<void>;
  onWarning: (error: Error) => void;
  onError: (error: Error) => void;
  timers: SupervisorTimers;
  watch?: typeof fs.watch;
};

export const ERROR_KEY_PREFIX = 'error:';

const errorTag = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.name : 'unknown';
};

export const safeChangeKey = async (changeKey: () => Promise<string>): Promise<string> => {
  try {
    return await changeKey();
  } catch (error) {
    return `${ERROR_KEY_PREFIX}${errorTag(error)}`;
  }
};

export const watchSettings = (options: WatchSettingsOptions): SettingsWatch => {
  const { timers } = options;
  const watch = options.watch ?? fs.watch;
  let lastKey = options.initialKey;
  let stopped = false;
  let debounceTimer: unknown;
  let pollTimer: unknown;
  let watcher: fs.FSWatcher | undefined;
  let watcherClosed = false;

  let fallbackReported = false;
  const inFlight = new Set<Promise<void>>();

  const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

  const reportFallback = (cause: unknown): void => {
    if (fallbackReported) return;
    fallbackReported = true;
    options.onWarning(new Error(`settings file watch unavailable, polling instead: ${asError(cause).message}`, { cause }));
  };

  const closeWatcher = (): void => {
    if (watcher === undefined || watcherClosed) return;
    watcherClosed = true;
    watcher.close();
  };

  const fire = async (): Promise<void> => {
    debounceTimer = undefined;
    if (stopped) return;
    const key = await safeChangeKey(options.changeKey);
    if (stopped) return;
    lastKey = key;
    try {
      await options.onChange();
    } catch (error) {
      options.onError(asError(error));
    }
  };

  const track = (work: () => Promise<void>): void => {
    const running = work()
      .catch((error: unknown) => options.onError(asError(error)))
      .finally(() => inFlight.delete(running));
    inFlight.add(running);
  };

  const scheduleEvaluation = (): void => {
    if (stopped) return;
    if (debounceTimer !== undefined) timers.clearTimeout(debounceTimer);
    debounceTimer = timers.setTimeout(() => track(fire), options.debounceMs);
  };

  const poll = async (): Promise<void> => {
    pollTimer = undefined;
    if (stopped) return;
    const key = await safeChangeKey(options.changeKey);
    if (stopped) return;
    if (key !== lastKey) {
      lastKey = key;
      scheduleEvaluation();
    }
    armPoll();
  };

  function armPoll(): void {
    pollTimer = timers.setTimeout(() => track(poll), options.pollMs);
  }

  try {
    watcher = watch(options.directory, { persistent: false }, (_eventType, filename) => {
      if (filename === null || filename === undefined || filename.toString() === options.file) scheduleEvaluation();
    });
    watcher.on('error', (error: Error) => {
      closeWatcher();
      reportFallback(error);
    });
  } catch (error) {
    watcher = undefined;
    reportFallback(error);
  }
  armPoll();

  return {
    stop: () => {
      stopped = true;
      if (debounceTimer !== undefined) timers.clearTimeout(debounceTimer);
      if (pollTimer !== undefined) timers.clearTimeout(pollTimer);
      debounceTimer = undefined;
      pollTimer = undefined;
      closeWatcher();
    },
    idle: async () => {
      await Promise.all(inFlight);
    },
  };
};
