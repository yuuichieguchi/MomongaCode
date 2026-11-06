import type { TraceStore } from './trace-store.ts';

export const BODY_PURGE_INTERVAL_MS = 10 * 60 * 1000;
export const LEGACY_MOVE_PAUSE_MS = 1000;

export type BodyPurgeTimers = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type BodyPurgeOptions = {
  store: Pick<TraceStore, 'purgeExpired' | 'moveLegacyContent'>;
  timers: BodyPurgeTimers;
  report(error: unknown): void;
  legacyRetentionMs?: number;
};

export type BodyPurge = { stop(): void };

export const startBodyPurge = ({ store, timers, report, legacyRetentionMs }: BodyPurgeOptions): BodyPurge => {
  let stopped = false;
  let handle: unknown;
  let legacyPending = legacyRetentionMs !== undefined;

  const arm = (delayMs: number): void => {
    handle = timers.setTimeout(tick, delayMs);
  };

  const tick = (): void => {
    handle = undefined;
    if (stopped) return;
    let nextDelayMs = BODY_PURGE_INTERVAL_MS;
    try {
      store.purgeExpired();
      if (legacyPending && legacyRetentionMs !== undefined) {
        if (store.moveLegacyContent({ retentionMs: legacyRetentionMs }) > 0) nextDelayMs = LEGACY_MOVE_PAUSE_MS;
        else legacyPending = false;
      }
    } catch (error) {
      report(error);
    }
    arm(nextDelayMs);
  };

  arm(BODY_PURGE_INTERVAL_MS);

  return {
    stop: () => {
      stopped = true;
      if (handle !== undefined) {
        timers.clearTimeout(handle);
        handle = undefined;
      }
    },
  };
};
