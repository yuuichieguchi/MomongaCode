import { describe, expect, it } from 'vitest';
import { GROUP_POLL_INTERVAL_MS, KILL_CONFIRM_MS, terminateGroup } from '@momonga/foundation';
import type { GroupTiming, ProcessGroupPort } from '@momonga/foundation';

interface FakeClock {
  ms: number;
}

const fakeTiming = (clock: FakeClock): GroupTiming => ({
  now: () => clock.ms,
  sleep: async (ms) => {
    clock.ms += ms;
  },
});

const groupThatSurvivesSigkillFor = (survivalMs: number, clock: FakeClock): ProcessGroupPort & { signals: NodeJS.Signals[] } => {
  let killedAt: number | undefined;
  const signals: NodeJS.Signals[] = [];
  return {
    signals,
    signal: async (_pgid, signal) => {
      signals.push(signal);
      if (signal === 'SIGKILL' && killedAt === undefined) killedAt = clock.ms;
    },
    alive: async () => killedAt === undefined || clock.ms - killedAt < survivalMs,
  };
};

describe('stopping a process group whose members stay visible after SIGKILL (the window after the kill is K, for every grace)', () => {
  it.for([0, 100])('returns killed when the group vanishes 1500 ms after SIGKILL, at grace %i', async (graceMs) => {
    const clock = { ms: 0 };
    const port = groupThatSurvivesSigkillFor(1500, clock);
    await expect(terminateGroup(4242, { graceMs, port, timing: fakeTiming(clock) })).resolves.toBe('killed');
    expect(port.signals[0]).toBe('SIGTERM');
    expect(port.signals).toContain('SIGKILL');
    expect(clock.ms).toBeGreaterThanOrEqual(graceMs + 1500);
    expect(clock.ms).toBeLessThan(graceMs + KILL_CONFIRM_MS);
  });

  it('settles as unconfirmed, without throwing, once K has passed after SIGKILL for a group that never vanishes', async () => {
    const clock = { ms: 0 };
    const port = groupThatSurvivesSigkillFor(Number.POSITIVE_INFINITY, clock);
    await expect(terminateGroup(4242, { graceMs: 100, port, timing: fakeTiming(clock) })).resolves.toBe('unconfirmed');
    expect(clock.ms).toBeGreaterThanOrEqual(100 + KILL_CONFIRM_MS);
    expect(clock.ms).toBeLessThanOrEqual(100 + KILL_CONFIRM_MS + 2 * GROUP_POLL_INTERVAL_MS);
  });
});
