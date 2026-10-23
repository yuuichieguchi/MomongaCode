import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers, fakeReapTiming } from '@momonga/testkit';

describe('fakeReapTiming (fake timers)', () => {
  it('now reads the fake clock', () => {
    const clock = createFakeClock(1000);
    const timing = fakeReapTiming(clock, createFakeTimers(clock));

    expect(timing.now()).toBe(1000);
    clock.set(4321);
    expect(timing.now()).toBe(4321);
  });

  it('sleep advances the fake timers and the clock together by exactly ms', async () => {
    const clock = createFakeClock(1000);
    const timers = createFakeTimers(clock);
    const timing = fakeReapTiming(clock, timers);
    const fired: number[] = [];
    timers.setTimeout(() => fired.push(clock.now()), 500);
    timers.setTimeout(() => fired.push(clock.now()), 501);

    await timing.sleep(500);

    expect(fired).toEqual([1500]);
    expect(clock.now()).toBe(1500);
    expect(timers.pending().map((timer) => timer.dueAt)).toEqual([1501]);
  });

  it('successive sleeps accumulate on the shared clock', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    const timing = fakeReapTiming(clock, timers);

    await timing.sleep(25);
    await timing.sleep(25);

    expect(timing.now()).toBe(50);
  });
});
