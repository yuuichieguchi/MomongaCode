import { describe, expect, it } from 'vitest';
import { POLL_INTERVAL_MS, waitUntil } from '@momonga/foundation';
import type { Timing } from '@momonga/foundation';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';

type Outcome<T> = { kind: 'found'; value: T } | { kind: 'timed_out' } | { kind: 'aborted' };

const fakeTiming = (startMs: number) => {
  const clock = createFakeClock(startMs);
  const timers = createFakeTimers(clock);
  const sleeps: number[] = [];
  const timing: Timing = {
    now: () => clock.now(),
    monotonicMs: () => clock.now(),
    setTimeout: (callback, ms) => {
      sleeps.push(ms);
      return timers.setTimeout(callback, ms);
    },
    clearTimeout: (handle) => timers.clearTimeout(handle),
  };
  return { timing, timers, sleeps, now: () => clock.now() };
};

type Fake = ReturnType<typeof fakeTiming>;

const macrotask = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

const MAX_DRIVE_STEPS = 10_000;

const drive = async <T>(fake: Fake, running: Promise<Outcome<T>>, onStep: () => void = () => undefined): Promise<Outcome<T>> => {
  let settled = false;
  const tracked = running.finally(() => {
    settled = true;
  });
  tracked.catch(() => undefined);
  for (let step = 0; step < MAX_DRIVE_STEPS; step += 1) {
    await macrotask();
    if (settled) return tracked;
    onStep();
    const next = fake.timers.nextDueAt();
    if (next !== undefined) fake.timers.advance(Math.max(0, next - fake.now()));
  }
  throw new Error(`waitUntil did not settle within ${MAX_DRIVE_STEPS} steps`);
};

const probeTaking = <T>(fake: Fake, probeMs: number, answers: ReadonlyArray<T | undefined>) => {
  const calls: number[] = [];
  const probe = async (): Promise<T | undefined> => {
    calls.push(fake.now());
    fake.timers.advance(probeMs);
    return answers[calls.length - 1];
  };
  return { probe, calls };
};

describe('waitUntil', () => {
  it('uses the 25 ms poll interval of the design', () => {
    expect(POLL_INTERVAL_MS).toBe(25);
  });

  it('probes, sleeps min(interval, remaining) and times out at the deadline', async () => {
    const fake = fakeTiming(0);
    const { probe, calls } = probeTaking<string>(fake, 0, []);
    const outcome = await drive(fake, waitUntil(fake.timing, probe, { intervalMs: 30, deadline: 100 }));
    expect(outcome).toEqual({ kind: 'timed_out' });
    expect(fake.sleeps).toEqual([30, 30, 30, 10]);
    expect(calls).toEqual([0, 30, 60, 90, 100]);
    expect(fake.now()).toBe(100);
  });

  it('counts the probe time against the deadline', async () => {
    const fake = fakeTiming(0);
    const { probe, calls } = probeTaking<string>(fake, 7, []);
    const outcome = await drive(fake, waitUntil(fake.timing, probe, { intervalMs: 30, deadline: 100 }));
    expect(outcome).toEqual({ kind: 'timed_out' });
    expect(fake.sleeps).toEqual([30, 30, 19]);
    expect(calls).toEqual([0, 37, 74, 100]);
    expect(fake.now()).toBe(107);
  });

  it('ends found with the first value the probe returns', async () => {
    const fake = fakeTiming(1_000);
    const { probe, calls } = probeTaking(fake, 0, [undefined, undefined, 'ready']);
    const outcome = await drive(fake, waitUntil(fake.timing, probe, { intervalMs: 30, deadline: 1_100 }));
    expect(outcome).toEqual({ kind: 'found', value: 'ready' });
    expect(calls).toEqual([1_000, 1_030, 1_060]);
    expect(fake.sleeps).toEqual([30, 30]);
  });

  it('probes once before looking at a deadline that has already passed', async () => {
    const fake = fakeTiming(500);
    const { probe, calls } = probeTaking(fake, 0, [42]);
    const outcome = await drive(fake, waitUntil(fake.timing, probe, { intervalMs: 30, deadline: 100 }));
    expect(outcome).toEqual({ kind: 'found', value: 42 });
    expect(calls).toEqual([500]);
  });

  it('times out after one probe and no sleep when the deadline has already passed', async () => {
    const fake = fakeTiming(500);
    const { probe, calls } = probeTaking<number>(fake, 0, []);
    const outcome = await drive(fake, waitUntil(fake.timing, probe, { intervalMs: 30, deadline: 100 }));
    expect(outcome).toEqual({ kind: 'timed_out' });
    expect(calls).toEqual([500]);
    expect(fake.sleeps).toEqual([]);
  });

  it('ends aborted after one probe when the signal has already fired', async () => {
    const fake = fakeTiming(0);
    const { probe, calls } = probeTaking<number>(fake, 0, []);
    const controller = new AbortController();
    controller.abort();
    const outcome = await drive(fake, waitUntil(fake.timing, probe, { intervalMs: 30, deadline: 1_000, signal: controller.signal }));
    expect(outcome).toEqual({ kind: 'aborted' });
    expect(calls).toEqual([0]);
    expect(fake.sleeps).toEqual([]);
  });

  it('ends aborted within one interval of a signal fired while it sleeps', async () => {
    const fake = fakeTiming(0);
    const { probe } = probeTaking<number>(fake, 0, []);
    const controller = new AbortController();
    let abortedAt: number | undefined;
    const outcome = await drive(fake, waitUntil(fake.timing, probe, { intervalMs: 30, deadline: 1_000, signal: controller.signal }), () => {
      if (abortedAt === undefined && fake.now() >= 45) {
        abortedAt = fake.now();
        controller.abort();
      }
    });
    expect(outcome).toEqual({ kind: 'aborted' });
    expect(abortedAt).toBeDefined();
    expect(fake.now()).toBeLessThanOrEqual((abortedAt as number) + 30);
  });

  it('propagates the error a probe throws, as the same object', async () => {
    const fake = fakeTiming(0);
    const failure = new Error('probe failed: EIO');
    let calls = 0;
    const probe = async (): Promise<number | undefined> => {
      calls += 1;
      if (calls === 2) throw failure;
      return undefined;
    };
    await expect(drive(fake, waitUntil(fake.timing, probe, { intervalMs: 30, deadline: 1_000 }))).rejects.toBe(failure);
    expect(calls).toBe(2);
    expect(fake.timers.pending()).toEqual([]);
  });

  describe('P-L1: ends within deadline - start + probeTime + intervalMs and never before the deadline', () => {
    const intervals = [1, 25, 40];
    const spans = [0, 10, 100, 257];
    const probeTimes = [0, 3, 50];
    for (const intervalMs of intervals) {
      for (const span of spans) {
        for (const probeMs of probeTimes) {
          it(`interval ${intervalMs}, deadline ${span} after start, probe ${probeMs}`, async () => {
            const start = 10_000;
            const fake = fakeTiming(start);
            const { probe, calls } = probeTaking<number>(fake, probeMs, []);
            const outcome = await drive(fake, waitUntil(fake.timing, probe, { intervalMs, deadline: start + span }));
            expect(outcome).toEqual({ kind: 'timed_out' });
            expect(fake.now() - start).toBeLessThanOrEqual(span + probeMs + intervalMs);
            expect(calls.at(-1) as number).toBeGreaterThanOrEqual(start + span - probeMs);
            expect(fake.now()).toBeGreaterThanOrEqual(start + span);
            expect(fake.sleeps.every((ms) => ms > 0 && ms <= intervalMs)).toBe(true);
          });
        }
      }
    }
  });
});
