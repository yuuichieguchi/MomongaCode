import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { spawn } from '@momonga/testkit/child-process';
import { HOLD_UNTIL_SIGNALLED_ARGV, createFakeClock, createFakeTimers, fakeReapTiming, pacedReapTiming } from '@momonga/testkit';

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

describe('pacedReapTiming (a fake clock paired with a real host operation)', () => {
  it('a sleep with no real operation in flight advances the clock and takes one turn', async () => {
    const clock = createFakeClock(0);
    const timing = pacedReapTiming(clock);

    await timing.sleep(25);
    await timing.sleep(25);

    expect(timing.now()).toBe(50);
  });

  it('a sleep returns only after the real operation it is paired with has ended, so a poll bound in fake time never ends before it', async () => {
    const clock = createFakeClock(0);
    const timing = pacedReapTiming(clock);
    const [command, ...args] = HOLD_UNTIL_SIGNALLED_ARGV;
    const child = spawn(command, args, { stdio: 'ignore' });
    let dead = false;
    const death = new Promise<void>((resolve) => {
      child.once('exit', () => {
        dead = true;
        resolve();
      });
    });
    child.kill('SIGKILL');
    void timing.pairedWith(() => death);

    const deadline = timing.now() + 50;
    let polls = 0;
    while (!dead && timing.now() < deadline) {
      polls += 1;
      await timing.sleep(25);
    }

    expect(dead).toBe(true);
    expect(polls).toBe(1);
    expect(timing.now()).toBe(25);
  });

  it('a real operation that failed no longer holds the sleep, and its failure stays with its owner', async () => {
    const clock = createFakeClock(0);
    const timing = pacedReapTiming(clock);
    const read = timing.pairedWith(() => fs.promises.readFile('/nonexistent/paced-reap-timing'));

    await timing.sleep(25);
    await timing.sleep(25);

    await expect(read).rejects.toThrow(/ENOENT/);
    expect(timing.now()).toBe(50);
  });

  it('refuses a sleep made by the operation it is paired with, which could never end, and the refusal ends the operation', async () => {
    const clock = createFakeClock(0);
    const timing = pacedReapTiming(clock);
    const operation = timing.pairedWith(async () => {
      await Promise.resolve();
      await timing.sleep(25);
    });

    await expect(operation).rejects.toThrow(/paired with this timing/);
    await timing.sleep(25);
    expect(timing.now()).toBe(25);
  });

  it('lets an operation paired with one timing sleep on another', async () => {
    const clock = createFakeClock(0);
    const timing = pacedReapTiming(clock);
    const other = pacedReapTiming(createFakeClock(0));

    await timing.pairedWith(() => other.sleep(25));
    await timing.sleep(25);

    expect(other.now()).toBe(25);
    expect(timing.now()).toBe(25);
  });

  it('records each sleep when it is asked for, before the sleep waits', async () => {
    const clock = createFakeClock(0);
    const timing = pacedReapTiming(clock);
    let release: () => void = () => undefined;
    void timing.pairedWith(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const sleeping = Promise.all([timing.sleep(25), timing.sleep(100)]);
    expect(timing.sleeps).toEqual([25, 100]);
    release();
    await sleeping;
  });

  it('fires the fake timers that fall inside a sleep, at their own time on the shared clock', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    const timing = pacedReapTiming(clock, timers);
    const fired: number[] = [];
    timers.setTimeout(() => fired.push(clock.now()), 100);

    await timing.sleep(25);
    expect(fired).toEqual([]);
    await timing.sleep(100);

    expect(fired).toEqual([100]);
    expect(timing.now()).toBe(125);
  });
});
