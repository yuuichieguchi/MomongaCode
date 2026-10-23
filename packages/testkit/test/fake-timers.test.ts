import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers, waitFor } from '@momonga/testkit';

describe('createFakeTimers', () => {
  it('fires due callbacks in due order while advancing the shared clock', () => {
    const clock = createFakeClock(1000);
    const timers = createFakeTimers(clock);
    const fired: Array<[string, number]> = [];
    timers.setTimeout(() => fired.push(['late', clock.now()]), 300);
    timers.setTimeout(() => fired.push(['early', clock.now()]), 100);
    timers.advance(99);
    expect(fired).toEqual([]);
    expect(timers.pending().map((timer) => timer.delayMs)).toEqual([300, 100]);
    timers.advance(250);
    expect(fired).toEqual([
      ['early', 1100],
      ['late', 1300],
    ]);
    expect(clock.now()).toBe(1349);
    expect(timers.pending()).toEqual([]);
  });

  it('fires timers scheduled by callbacks when they fall inside the window', () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    const fired: number[] = [];
    timers.setTimeout(() => {
      fired.push(clock.now());
      timers.setTimeout(() => fired.push(clock.now()), 50);
    }, 50);
    timers.advance(100);
    expect(fired).toEqual([50, 100]);
  });

  it('does not fire cleared timers', () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    let fired = false;
    const handle = timers.setTimeout(() => {
      fired = true;
    }, 10);
    timers.clearTimeout(handle);
    timers.advance(20);
    expect(fired).toBe(false);
    expect(timers.pending()).toEqual([]);
  });

  it('rejects a negative advance', () => {
    const timers = createFakeTimers(createFakeClock(0));
    expect(() => timers.advance(-1)).toThrow(/non-negative/);
  });
});

describe('waitFor', () => {
  it('resolves once the predicate becomes true', async () => {
    let ready = false;
    setImmediate(() => {
      ready = true;
    });
    await waitFor(() => ready);
    expect(ready).toBe(true);
  });

  it('rejects with the description when the predicate never holds', async () => {
    await expect(waitFor(() => false, { maxTurns: 5, description: 'never' })).rejects.toThrow(/5 event-loop turns: never/);
  });
});
