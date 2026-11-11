import { describe, expect, it } from 'vitest';
import { Deadline } from '@momonga/foundation';
import type { Timing } from '@momonga/foundation';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import type { FakeTimers } from '@momonga/testkit';

const ONE_HOUR_MS = 3_600_000;

const WALL_START_MS = 1_800_000_000_000;

interface SteppedWall {
  readonly timing: Timing;
  readonly timers: FakeTimers;
  stepWall(ms: number): void;
}

const steppedWall = (): SteppedWall => {
  const timers = createFakeTimers(createFakeClock(0));
  let wall = WALL_START_MS;
  return {
    timers,
    timing: { now: () => wall + timers.monotonicMs(), monotonicMs: () => timers.monotonicMs(), setTimeout: (callback, ms) => timers.setTimeout(callback, ms), clearTimeout: (handle) => timers.clearTimeout(handle) },
    stepWall: (ms) => {
      wall += ms;
    },
  };
};

describe('a deadline is measured on the monotonic clock', () => {
  it('keeps its remaining time and stays open when the wall clock steps forward one hour', () => {
    const { timing, timers, stepWall } = steppedWall();
    const deadline = Deadline.after(1000, timing);
    timers.advance(400);
    stepWall(ONE_HOUR_MS);
    expect(deadline.remainingMs()).toBe(600);
    expect(deadline.signal.aborted).toBe(false);
    timers.advance(600);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.remainingMs()).toBe(0);
  });

  it('keeps its remaining time when the wall clock steps back one hour', () => {
    const { timing, timers, stepWall } = steppedWall();
    const deadline = Deadline.after(1000, timing);
    timers.advance(400);
    stepWall(-ONE_HOUR_MS);
    expect(deadline.remainingMs()).toBe(600);
    expect(deadline.child(10_000).remainingMs()).toBe(600);
  });
});

describe('a wall value stored by another process becomes a deadline once, at the boundary', () => {
  it('is expired at once, with no timer, when the wall value is in the past', () => {
    const { timing, timers } = steppedWall();
    const deadline = Deadline.fromWall(timing.now() - 1, timing);
    expect(deadline.expired).toBe(true);
    expect(deadline.remainingMs()).toBe(0);
    expect(timers.pending()).toEqual([]);
  });

  it('is expired at once when the wall value is now', () => {
    const { timing } = steppedWall();
    expect(Deadline.fromWall(timing.now(), timing).expired).toBe(true);
  });

  it('has the time left until the wall value, and a later step of the wall clock does not move it', () => {
    const { timing, timers, stepWall } = steppedWall();
    const deadline = Deadline.fromWall(timing.now() + 500, timing);
    expect(deadline.remainingMs()).toBe(500);
    stepWall(ONE_HOUR_MS);
    timers.advance(200);
    expect(deadline.remainingMs()).toBe(300);
    expect(deadline.expired).toBe(false);
    timers.advance(300);
    expect(deadline.expired).toBe(true);
  });
});
