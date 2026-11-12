import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers, createTempDir } from '@momonga/testkit';
import { createRealWorkScope, pump, pumpUntil } from './fixtures/p3-harness.ts';

const realIoRoundTrips = async (count: number): Promise<void> => {
  const dir = createTempDir();
  try {
    for (let index = 0; index < count; index += 1) {
      const file = path.join(dir, `f${String(index)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await fs.promises.writeFile(file, 'x');
      await fs.promises.rm(file);
    }
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
};

describe('pumpUntil', () => {
  it('meets a condition reached through real I/O alone without advancing fake time past an unrelated pending timer', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    let deadlineFired = false;
    timers.setTimeout(() => {
      deadlineFired = true;
    }, 84_000);
    const realWork = createRealWorkScope();
    let ioDone = false;
    realWork.run(() => {
      void realIoRoundTrips(20).then(() => {
        ioDone = true;
      });
    });
    await pumpUntil(timers, () => ioDone, {
      realWork,
      maxMs: 500,
      description: 'real I/O',
    });
    expect(ioDone).toBe(true);
    expect(clock.now()).toBe(0);
    expect(deadlineFired).toBe(false);
  });

  it('still advances fake time when the condition depends on a fake timer', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    let fired = false;
    timers.setTimeout(() => {
      fired = true;
    }, 200);
    await pumpUntil(timers, () => fired, {
      realWork: createRealWorkScope(),
      maxMs: 200,
      description: 'fake timer',
    });
    expect(clock.now()).toBe(200);
  });

  it('does not advance fake time while a real timer created before drive starts still gates the next real I/O step', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    let deadlineFired = false;
    timers.setTimeout(() => {
      deadlineFired = true;
    }, 84_000);
    const realWork = createRealWorkScope();
    let ioDone = false;
    realWork.run(() => {
      void (async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const dir = createTempDir();
        await fs.promises.rm(dir, { recursive: true, force: true });
        ioDone = true;
      })();
    });
    await pumpUntil(timers, () => ioDone, {
      maxMs: 500,
      description: 'real I/O gated by a pre-existing real timer',
      realWork,
    });
    expect(ioDone).toBe(true);
    expect(clock.now()).toBe(0);
    expect(deadlineFired).toBe(false);
  });

  it('ignores real timers the test body creates outside run after an async scope setup', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    const startScoped = async () => {
      const realWork = createRealWorkScope();
      await Promise.resolve();
      let fired = false;
      realWork.run(() => {
        timers.setTimeout(() => {
          fired = true;
        }, 200);
      });
      return { realWork, fired: () => fired };
    };
    const scoped = await startScoped();
    const testBodyTimer = setTimeout(() => undefined, 5000);
    try {
      await pumpUntil(timers, scoped.fired, {
        realWork: scoped.realWork,
        maxMs: 200,
        description: 'fake timer with a test-body real timer pending',
      });
      expect(scoped.fired()).toBe(true);
      expect(clock.now()).toBe(200);
    } finally {
      clearTimeout(testBodyTimer);
    }
  });

  it('advances directly to the next pending timer however far away it is', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    const advances: number[] = [];
    const originalAdvance = timers.advanceAsync;
    timers.advanceAsync = (ms) => {
      advances.push(ms);
      return originalAdvance(ms);
    };
    let fired = false;
    timers.setTimeout(() => {
      fired = true;
    }, 86_400_000);
    await pumpUntil(timers, () => fired, { realWork: createRealWorkScope(), maxMs: 86_400_000, description: 'a day-long timer' });
    expect(advances).toEqual([86_400_000]);
    expect(clock.now()).toBe(86_400_000);
  });

  it('fails when the next timer lies beyond the fake bound', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    timers.setTimeout(() => undefined, 1000);
    await expect(pumpUntil(timers, () => false, { realWork: createRealWorkScope(), maxMs: 999, description: 'never' })).rejects.toThrow(/never not met within 999 fake ms/);
    expect(clock.now()).toBe(0);
  });
});

describe('pump', () => {
  it('fires every timer due inside the window in order and leaves the clock at the window end', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    const fired: number[] = [];
    timers.setTimeout(() => {
      fired.push(clock.now());
      timers.setTimeout(() => fired.push(clock.now()), 300);
    }, 100);
    timers.setTimeout(() => fired.push(clock.now()), 5000);
    await pump(timers, createRealWorkScope(), 1000);
    expect(fired).toEqual([100, 400]);
    expect(clock.now()).toBe(1000);
  });
});
