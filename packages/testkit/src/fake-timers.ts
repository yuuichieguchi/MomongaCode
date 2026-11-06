import { AsyncResource } from 'node:async_hooks';
import type { FakeClock } from './fake-clock.ts';

export type PendingTimer = { id: number; delayMs: number; dueAt: number };

export type FakeTimers = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  advance(ms: number): void;
  pending(): PendingTimer[];
  now(): number;
  nextDueAt(): number | undefined;
};

type Entry = PendingTimer & { callback: () => void; source: () => void; armedBy: (() => void) | undefined };

export const createFakeTimers = (clock: FakeClock): FakeTimers => {
  const entries = new Map<number, Entry>();
  let nextId = 1;
  let firing: Entry | undefined;
  const earliestDue = (limit: number): Entry | undefined => {
    let best: Entry | undefined;
    for (const entry of entries.values()) {
      if (entry.dueAt > limit) continue;
      if (best === undefined || entry.dueAt < best.dueAt || (entry.dueAt === best.dueAt && entry.id < best.id)) best = entry;
    }
    return best;
  };
  return {
    setTimeout: (callback, ms) => {
      const delayMs = Math.max(0, Number.isFinite(ms) ? ms : 0);
      const id = nextId++;
      const armedBy = firing !== undefined && delayMs === 0 ? firing.source : undefined;
      entries.set(id, { id, delayMs, dueAt: clock.now() + delayMs, callback: AsyncResource.bind(callback), source: callback, armedBy });
      return id;
    },
    clearTimeout: (handle) => {
      if (typeof handle === 'number') entries.delete(handle);
    },
    advance: (ms) => {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`FakeTimers.advance: ms must be a non-negative finite number, got ${ms}`);
      const target = clock.now() + ms;
      for (let entry = earliestDue(target); entry !== undefined; entry = earliestDue(target)) {
        entries.delete(entry.id);
        clock.set(Math.max(clock.now(), entry.dueAt));
        if (entry.armedBy === entry.source) {
          throw new Error(
            `FakeTimers.advance: timer ${JSON.stringify({ id: entry.id, delayMs: entry.delayMs, dueAt: entry.dueAt })} re-armed itself at the fake instant it fired, so fake time can never pass it`,
          );
        }
        firing = entry;
        try {
          entry.callback();
        } finally {
          firing = undefined;
        }
      }
      clock.set(target);
    },
    now: () => clock.now(),
    nextDueAt: () => earliestDue(Number.POSITIVE_INFINITY)?.dueAt,
    pending: () =>
      [...entries.values()].sort((a, b) => a.id - b.id).map(({ id, delayMs, dueAt }) => ({ id, delayMs, dueAt })),
  };
};
