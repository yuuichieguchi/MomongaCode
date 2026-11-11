import { AsyncResource } from 'node:async_hooks';
import type { FakeClock } from './fake-clock.ts';

export type PendingTimer = { id: number; delayMs: number; dueAt: number };

export type FakeTimers = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  timeoutSignal(ms: number): AbortSignal;
  advance(ms: number): void;
  pending(): PendingTimer[];
  now(): number;
  monotonicMs(): number;
  nextDueAt(): number | undefined;
};

type Entry = PendingTimer & { callback: () => void };

const NODE_TIMEOUT_MAX_MS = 2_147_483_647;

const nodeTimerDelay = (ms: unknown): number => {
  const coerced = Number(ms) * 1;
  const clamped = coerced >= 1 && coerced <= NODE_TIMEOUT_MAX_MS ? coerced : 1;
  return Math.trunc(clamped);
};

export const createFakeTimers = (clock: FakeClock): FakeTimers => {
  const entries = new Map<number, Entry>();
  let nextId = 1;
  const earliestDue = (limit: number): Entry | undefined => {
    let best: Entry | undefined;
    for (const entry of entries.values()) {
      if (entry.dueAt > limit) continue;
      if (best === undefined || entry.dueAt < best.dueAt || (entry.dueAt === best.dueAt && entry.id < best.id)) best = entry;
    }
    return best;
  };
  const start = (callback: () => void, ms: number): number => {
    const delayMs = nodeTimerDelay(ms);
    const id = nextId++;
    entries.set(id, { id, delayMs, dueAt: clock.now() + delayMs, callback: AsyncResource.bind(callback) });
    return id;
  };
  return {
    setTimeout: start,
    timeoutSignal: (ms) => {
      const controller = new AbortController();
      start(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms);
      return controller.signal;
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
        entry.callback();
      }
      clock.set(target);
    },
    now: () => clock.now(),
    monotonicMs: () => clock.now(),
    nextDueAt: () => earliestDue(Number.POSITIVE_INFINITY)?.dueAt,
    pending: () =>
      [...entries.values()].sort((a, b) => a.id - b.id).map(({ id, delayMs, dueAt }) => ({ id, delayMs, dueAt })),
  };
};
