import { AsyncResource } from 'node:async_hooks';
import type { FakeClock } from './fake-clock.ts';

export type PendingTimer = { id: number; delayMs: number; dueAt: number };

export type FakeTimers = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  timeoutSignal(ms: number): AbortSignal;
  advance(ms: number): void;
  advanceAsync(ms: number): Promise<void>;
  pending(): PendingTimer[];
  now(): number;
  monotonicMs(): number;
  nextDueAt(): number | undefined;
};

type Entry = PendingTimer & { callback: () => void };

const realSetImmediate = setImmediate;

const microtasksDrained = (): Promise<void> => new Promise<void>((resolve) => realSetImmediate(resolve));

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
    entries.set(id, { id, delayMs, dueAt: clock.monotonicMs() + delayMs, callback: AsyncResource.bind(callback) });
    return id;
  };
  const moveTo = (monotonicMs: number): void => {
    clock.advance(Math.max(0, monotonicMs - clock.monotonicMs()));
  };
  const targetOf = (name: string, ms: number): number => {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`FakeTimers.${name}: ms must be a non-negative finite number, got ${ms}`);
    return clock.monotonicMs() + ms;
  };
  const takeDue = (target: number): Entry | undefined => {
    const entry = earliestDue(target);
    if (entry === undefined) return undefined;
    entries.delete(entry.id);
    moveTo(entry.dueAt);
    return entry;
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
      const target = targetOf('advance', ms);
      const first = takeDue(target);
      if (first !== undefined) {
        first.callback();
        const second = earliestDue(target);
        if (second !== undefined) {
          throw new Error(
            `FakeTimers.advance: timer ${second.id}, due at ${second.dueAt}, falls inside this advance of ${ms} ms after timer ${first.id} already ran; the real scheduler runs every pending microtask between two timer callbacks and a synchronous advance cannot, so use await advanceAsync(${ms})`,
          );
        }
      }
      moveTo(target);
    },
    advanceAsync: async (ms) => {
      const target = targetOf('advanceAsync', ms);
      for (let entry = takeDue(target); entry !== undefined; entry = takeDue(target)) {
        entry.callback();
        await microtasksDrained();
      }
      moveTo(target);
    },
    now: () => clock.now(),
    monotonicMs: () => clock.monotonicMs(),
    nextDueAt: () => earliestDue(Number.POSITIVE_INFINITY)?.dueAt,
    pending: () =>
      [...entries.values()].sort((a, b) => a.id - b.id).map(({ id, delayMs, dueAt }) => ({ id, delayMs, dueAt })),
  };
};
