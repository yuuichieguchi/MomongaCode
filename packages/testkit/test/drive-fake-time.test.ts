import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers, driveFakeTime } from '@momonga/testkit';
import type { FakeTimers } from '@momonga/testkit';

const PERIOD_MS = 600_000;

const armPeriodic = (timers: FakeTimers, periodMs: number, onTick: () => void = () => undefined): void => {
  const tick = (): void => {
    onTick();
    timers.setTimeout(tick, periodMs);
  };
  timers.setTimeout(tick, periodMs);
};

const blockFor = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

describe('driveFakeTime', () => {
  it('runs the continuation of a timer before the next timer due at the same instant, as the real scheduler does', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    const order: string[] = [];
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    timers.setTimeout(() => release(), 100);
    const bound = timers.setTimeout(() => order.push('bound fired'), 100);
    let finished = false;
    void (async () => {
      await released;
      await Promise.resolve();
      timers.clearTimeout(bound);
      order.push('continuation');
      finished = true;
    })();

    await driveFakeTime(timers, { done: () => finished, horizonAt: 1000, description: 'the continuation' });

    expect(order).toEqual(['continuation']);
    expect(clock.now()).toBe(100);
  });

  it('fires each timer of the scenario up to its horizon and never fast-forwards a periodic timer beyond it', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    let periodicTicks = 0;
    armPeriodic(timers, PERIOD_MS, () => {
      periodicTicks += 1;
    });
    let retries = 0;
    const retry = (): void => {
      retries += 1;
      if (retries < 3) timers.setTimeout(retry, 8000);
    };
    timers.setTimeout(retry, 500);

    await driveFakeTime(timers, { done: () => retries === 3, horizonAt: 90_000, description: 'three retries' });

    expect(retries).toBe(3);
    expect(clock.now()).toBe(16_500);
    expect(periodicTicks).toBe(0);
    expect(timers.pending().map((timer) => timer.delayMs)).toEqual([PERIOD_MS]);
  });

  it('yields a macrotask on every step, so I/O that settles the scenario arrives while a timer is pending', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    armPeriodic(timers, PERIOD_MS);
    let arrived = false;
    setImmediate(() => {
      setImmediate(() => {
        arrived = true;
      });
    });

    await driveFakeTime(timers, { done: () => arrived, horizonAt: 90_000, description: 'the I/O' });

    expect(arrived).toBe(true);
    expect(clock.now()).toBe(0);
  });

  it('fails fast, naming the pending timers, when its predicate never holds while a timer re-arms inside the horizon', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    armPeriodic(timers, 1);
    const startedAt = performance.now();

    await expect(driveFakeTime(timers, { done: () => false, horizonAt: 90_000, maxSteps: 1000, description: 'never' })).rejects.toThrow(
      /never not met within 90000 fake ms: 1000 steps used; pending timers \[\{"id":\d+,"delayMs":1,"dueAt":\d+\}\]/,
    );
    expect(performance.now() - startedAt).toBeLessThan(5000);
  });

  it('fails fast when the scenario is quiet and the next timer is due beyond the horizon', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    armPeriodic(timers, PERIOD_MS);

    await expect(driveFakeTime(timers, { done: () => false, horizonAt: 90_000, quiet: () => true, description: 'never' })).rejects.toThrow(
      /never not met within 90000 fake ms: the next timer is due beyond the horizon; pending timers \[\{"id":\d+,"delayMs":600000,"dueAt":600000\}\]/,
    );
    expect(clock.now()).toBe(0);
  });

  it('honours its real-time deadline even when the action of every step never yields', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    armPeriodic(timers, 1, () => blockFor(20));
    const startedAt = performance.now();

    await expect(
      driveFakeTime(timers, { done: () => false, horizonAt: 90_000, maxSteps: Number.MAX_SAFE_INTEGER, deadlineMs: 200, description: 'never' }),
    ).rejects.toThrow(/never not met within 90000 fake ms: the real-time deadline of 200 ms passed; pending timers/);
    expect(performance.now() - startedAt).toBeLessThan(2000);
  });

  it('honours its real-time deadline even when its predicate never yields', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    const startedAt = performance.now();

    await expect(
      driveFakeTime(timers, {
        done: () => {
          blockFor(20);
          return false;
        },
        horizonAt: 90_000,
        maxSteps: Number.MAX_SAFE_INTEGER,
        deadlineMs: 200,
        description: 'never',
      }),
    ).rejects.toThrow(/the real-time deadline of 200 ms passed/);
    expect(performance.now() - startedAt).toBeLessThan(2000);
  });
});
