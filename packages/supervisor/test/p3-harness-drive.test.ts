import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import { createRealWorkScope, drive } from './fixtures/p3-harness.ts';

const realIoRoundTrips = async (count: number): Promise<void> => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'drive-contract-'));
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

describe('drive', () => {
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
    await drive(timers, () => ioDone, {
      realWork,
      stepMs: 50,
      maxSteps: 10,
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
    await drive(timers, () => fired, {
      realWork: createRealWorkScope(),
      stepMs: 50,
      maxSteps: 4,
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
        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'drive-pre-timer-'));
        await fs.promises.rm(dir, { recursive: true, force: true });
        ioDone = true;
      })();
    });
    await drive(timers, () => ioDone, {
      stepMs: 50,
      maxSteps: 10,
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
      await new Promise<void>((resolve) => setImmediate(resolve));
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
      await drive(timers, scoped.fired, {
        realWork: scoped.realWork,
        stepMs: 50,
        maxSteps: 4,
        description: 'fake timer with a test-body real timer pending',
      });
      expect(scoped.fired()).toBe(true);
      expect(clock.now()).toBe(200);
    } finally {
      clearTimeout(testBodyTimer);
    }
  });
});
