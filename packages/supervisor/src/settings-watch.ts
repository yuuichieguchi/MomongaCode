import fs from 'node:fs';
import type { SupervisorTimers } from './constants.ts';

export type SettingsWatch = { stop(): void };

export type WatchSettingsOptions = {
  directory: string;
  file: string;
  debounceMs: number;
  pollMs: number;
  changeKey: () => string;
  initialKey: string;
  onChange: () => void;
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

export const safeChangeKey = (changeKey: () => string): string => {
  try {
    return changeKey();
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

  const fire = (): void => {
    debounceTimer = undefined;
    if (stopped) return;
    lastKey = safeChangeKey(options.changeKey);
    try {
      options.onChange();
    } catch (error) {
      options.onError(asError(error));
    }
  };

  const scheduleEvaluation = (): void => {
    if (stopped) return;
    if (debounceTimer !== undefined) timers.clearTimeout(debounceTimer);
    debounceTimer = timers.setTimeout(fire, options.debounceMs);
  };

  const armPoll = (): void => {
    pollTimer = timers.setTimeout(() => {
      pollTimer = undefined;
      if (stopped) return;
      const key = safeChangeKey(options.changeKey);
      if (key !== lastKey) {
        lastKey = key;
        scheduleEvaluation();
      }
      armPoll();
    }, options.pollMs);
  };

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
  };
};
