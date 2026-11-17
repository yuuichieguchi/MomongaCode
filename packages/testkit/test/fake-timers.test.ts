import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers, waitFor } from '@momonga/testkit';

describe('createFakeTimers', () => {
  it('fires due callbacks in due order while advancing the shared clock', async () => {
    const clock = createFakeClock(1000);
    const timers = createFakeTimers(clock);
    const fired: Array<[string, number]> = [];
    timers.setTimeout(() => fired.push(['late', clock.now()]), 300);
    timers.setTimeout(() => fired.push(['early', clock.now()]), 100);
    timers.advance(99);
    expect(fired).toEqual([]);
    expect(timers.pending().map((timer) => timer.delayMs)).toEqual([300, 100]);
    await timers.advanceAsync(250);
    expect(fired).toEqual([
      ['early', 1100],
      ['late', 1300],
    ]);
    expect(clock.now()).toBe(1349);
    expect(timers.pending()).toEqual([]);
  });

  it('fires timers scheduled by callbacks when they fall inside the window', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    const fired: number[] = [];
    timers.setTimeout(() => {
      fired.push(clock.now());
      timers.setTimeout(() => fired.push(clock.now()), 50);
    }, 50);
    await timers.advanceAsync(100);
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

  it('reports the clock and the earliest pending due time', () => {
    const clock = createFakeClock(1000);
    const timers = createFakeTimers(clock);
    expect(timers.nextDueAt()).toBeUndefined();
    timers.setTimeout(() => undefined, 300);
    const early = timers.setTimeout(() => undefined, 100);
    expect(timers.now()).toBe(1000);
    expect(timers.nextDueAt()).toBe(1100);
    timers.clearTimeout(early);
    expect(timers.nextDueAt()).toBe(1300);
  });

  it('runs a callback in the async context that scheduled it, not the context that advances', () => {
    const storage = new AsyncLocalStorage<string>();
    const timers = createFakeTimers(createFakeClock(0));
    const seen: Array<string | undefined> = [];
    storage.run('scheduler', () => {
      timers.setTimeout(() => seen.push(storage.getStore()), 10);
    });
    storage.run('advancer', () => timers.advance(10));
    expect(seen).toEqual(['scheduler']);
  });

  it('fires a callback that re-arms itself at 0 ms forever once per fake ms, as Node coerces the delay to 1', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    let firings = 0;
    const tick = (): void => {
      firings += 1;
      timers.setTimeout(tick, 0);
    };
    timers.setTimeout(tick, 0);
    await timers.advanceAsync(10);
    expect(firings).toBe(10);
    expect(timers.pending().map((timer) => timer.dueAt)).toEqual([clock.now() + 1]);
  });

  it('finishes a 0 ms retry that re-arms 3 times and then stops inside one advance', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    const fired: number[] = [];
    const retry = (): void => {
      fired.push(clock.now());
      if (fired.length < 4) timers.setTimeout(retry, 0);
    };
    timers.setTimeout(retry, 0);
    await timers.advanceAsync(10);
    expect(fired).toEqual([1, 2, 3, 4]);
    expect(timers.pending()).toEqual([]);
  });

  it.each([2 ** 31, 2_147_483_647.5, Number.NaN, undefined, -5, 0.5, Number.POSITIVE_INFINITY])('arms a delay of %s due at now + 1, as Node does', (ms) => {
    const clock = createFakeClock(1000);
    const timers = createFakeTimers(clock);
    timers.setTimeout(() => undefined, ms as number);
    expect(timers.pending()).toEqual([{ id: 1, delayMs: 1, dueAt: 1001 }]);
  });

  it('truncates a non-integer delay, as Node does', () => {
    const timers = createFakeTimers(createFakeClock(0));
    timers.setTimeout(() => undefined, 2.7);
    expect(timers.pending()).toEqual([{ id: 1, delayMs: 2, dueAt: 2 }]);
  });

  it('rejects a negative advance', async () => {
    const timers = createFakeTimers(createFakeClock(0));
    expect(() => timers.advance(-1)).toThrow(/non-negative/);
    await expect(timers.advanceAsync(-1)).rejects.toThrow(/non-negative/);
  });
});

describe('createFakeTimers keeps the order of the real scheduler', () => {
  it('runs a continuation scheduled by the first due timer before the second due timer fires', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    const order: string[] = [];
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    timers.setTimeout(() => release(), 100);
    const bound = timers.setTimeout(() => order.push('bound fired'), 100);
    void (async () => {
      await released;
      await Promise.resolve();
      await Promise.resolve();
      order.push('continuation');
      timers.clearTimeout(bound);
    })();

    await timers.advanceAsync(100);

    expect(order).toEqual(['continuation']);
    expect(timers.pending()).toEqual([]);
  });

  it('refuses to run a second callback inside one synchronous advance, which has no checkpoint to give', () => {
    const timers = createFakeTimers(createFakeClock(0));
    const fired: string[] = [];
    timers.setTimeout(() => fired.push('first'), 10);
    timers.setTimeout(() => fired.push('second'), 20);

    expect(() => timers.advance(20)).toThrow(/advanceAsync/);
    expect(fired).toEqual(['first']);
  });

  it('resolves an asynchronous advance only after the continuations of its last callback ran', async () => {
    const timers = createFakeTimers(createFakeClock(0));
    const order: string[] = [];
    timers.setTimeout(() => {
      void Promise.resolve()
        .then(() => undefined)
        .then(() => order.push('continuation'));
    }, 10);

    await timers.advanceAsync(10);
    order.push('advanced');

    expect(order).toEqual(['continuation', 'advanced']);
  });

  it('keeps wall time and monotonic time as two values: a step of the wall clock moves no timer and no monotonic reading', async () => {
    const clock = createFakeClock(1000);
    const timers = createFakeTimers(clock);
    let fired = false;
    timers.setTimeout(() => {
      fired = true;
    }, 500);
    expect(timers.monotonicMs()).toBe(1000);

    clock.stepWall(3_600_000);

    expect(timers.now()).toBe(3_601_000);
    expect(timers.monotonicMs()).toBe(1000);
    expect(fired).toBe(false);
    expect(timers.pending()).toEqual([{ id: 1, delayMs: 500, dueAt: 1500 }]);
    timers.advance(499);
    expect(fired).toBe(false);
    timers.advance(1);
    expect(fired).toBe(true);
    expect(timers.now()).toBe(3_601_500);
    expect(timers.monotonicMs()).toBe(1500);
  });

  it('a step of the wall clock backwards leaves the monotonic clock where it was', () => {
    const clock = createFakeClock(1000);
    clock.advance(10);
    clock.stepWall(-600);
    expect(clock.now()).toBe(410);
    expect(clock.monotonicMs()).toBe(1010);
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
    await expect(waitFor(() => false, { boundMs: 5, description: 'never' })).rejects.toThrow(/not met within 5 ms: never/);
  });
});
