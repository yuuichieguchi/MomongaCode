import { describe, expect, it } from 'vitest';
import { Deadline, KILL_CONFIRM_MS, forceKillGroup, terminateGroup, waitForGroupGone } from '@momonga/foundation';
import type { ProcessGroupPort, Timing } from '@momonga/foundation';
import { createFakeClock, createFakeTimers, createSteppingTiming } from '@momonga/testkit';

const fakeDeadlineTiming = (): { timing: Timing; advance(ms: number): void } => {
  const clock = createFakeClock(1_000_000);
  const timers = createFakeTimers(clock);
  return { timing: timers, advance: timers.advance };
};

const fakeGroupTiming = (): { timing: Timing; sleeps: number[]; now(): number } => {
  const clock = createFakeClock(0);
  const timing = createSteppingTiming(clock);
  return { sleeps: timing.sleeps, now: () => clock.now(), timing };
};

const groupPort = (aliveUntil: () => boolean): { port: ProcessGroupPort; signals: string[] } => {
  const signals: string[] = [];
  return {
    signals,
    port: {
      signal: async (_pgid, signal) => void signals.push(signal),
      alive: async () => aliveUntil(),
    },
  };
};

describe('Deadline on an injected timing', () => {
  it('counts down and expires on the injected clock without any real time passing', () => {
    const fake = fakeDeadlineTiming();
    const deadline = Deadline.after(1000, fake.timing);
    expect(deadline.remainingMs()).toBe(1000);
    fake.advance(999);
    expect(deadline.expired).toBe(false);
    fake.advance(1);
    expect(deadline.expired).toBe(true);
    expect(deadline.remainingMs()).toBe(0);
  });

  it('gives a child the smaller of its timeout and the parent remainder on the same timing', () => {
    const fake = fakeDeadlineTiming();
    const parent = Deadline.after(1000, fake.timing);
    fake.advance(400);
    expect(parent.child(10_000).remainingMs()).toBe(600);
    const child = parent.child(100);
    fake.advance(100);
    expect(child.expired).toBe(true);
    expect(parent.expired).toBe(false);
  });

  it('dispose cancels the timer on the injected timing', () => {
    const fake = fakeDeadlineTiming();
    const deadline = Deadline.after(1000, fake.timing);
    deadline.dispose();
    fake.advance(5000);
    expect(deadline.expired).toBe(false);
  });
});

describe('process group termination on an injected timing', () => {
  it('waitForGroupGone polls on the injected sleep and gives up at the injected deadline', async () => {
    const fake = fakeGroupTiming();
    const { port } = groupPort(() => true);
    expect(await waitForGroupGone(10, 35, port, fake.timing)).toBe(false);
    expect(fake.sleeps).toEqual([10, 10, 10, 10]);
  });

  it('forceKillGroup re-sends SIGKILL every poll until the group is gone', async () => {
    const fake = fakeGroupTiming();
    let polls = 0;
    const { port, signals } = groupPort(() => ++polls <= 3);
    expect(await forceKillGroup(10, { deadline: 10_000, port, timing: fake.timing })).toBe(true);
    expect(signals).toEqual(['SIGKILL', 'SIGKILL', 'SIGKILL']);
  });

  it('terminateGroup SIGTERMs, waits the grace on the injected timing, then SIGKILLs and reports killed', async () => {
    const fake = fakeGroupTiming();
    let killed = false;
    const signals: string[] = [];
    const port: ProcessGroupPort = {
      signal: async (_pgid, signal) => {
        signals.push(signal);
        if (signal === 'SIGKILL') killed = true;
      },
      alive: async () => !killed,
    };
    expect(await terminateGroup(10, { graceMs: 100, port, timing: fake.timing })).toBe('killed');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(fake.now()).toBeGreaterThanOrEqual(100);
  });

  it('terminateGroup reports unconfirmed when SIGKILL does not take within the window K after it', async () => {
    const fake = fakeGroupTiming();
    const { port } = groupPort(() => true);
    expect(await terminateGroup(10, { graceMs: 100, port, timing: fake.timing })).toBe('unconfirmed');
    expect(fake.now()).toBeGreaterThanOrEqual(100 + KILL_CONFIRM_MS);
    expect(fake.now()).toBeLessThanOrEqual(100 + KILL_CONFIRM_MS + 20);
  });
});
