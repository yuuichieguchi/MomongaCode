import { describe, expect, it } from 'vitest';
import { KILL_CONFIRM_MS, groupTerminationBoundMs, terminateGroup } from '@momonga/foundation';
import type { ProcessGroupPort, Timing } from '@momonga/foundation';
import { createFakeClock, createSteppingTiming } from '@momonga/testkit';

const PGID = 1_999_999_101;
const POLL_MS = 10;

type Scripted = { port: ProcessGroupPort; timing: Timing; now(): number; killedAt(): number | undefined; termAt(): number | undefined };

const ignoresTerm = (goneAfterKillMs: number | undefined): Scripted => {
  const clock = createFakeClock(0);
  let termAt: number | undefined;
  let killedAt: number | undefined;
  const port: ProcessGroupPort = {
    signal: async (pgid, signal) => {
      if (pgid !== PGID) throw new Error(`unexpected group ${pgid}`);
      if (signal === 'SIGTERM') termAt ??= clock.now();
      if (signal === 'SIGKILL') killedAt ??= clock.now();
    },
    alive: async () => killedAt === undefined || goneAfterKillMs === undefined || clock.now() < killedAt + goneAfterKillMs,
  };
  return { port, timing: createSteppingTiming(clock), now: () => clock.now(), killedAt: () => killedAt, termAt: () => termAt };
};

const GRACES = [0, 1000, 30_000];

describe('terminateGroup confirms a SIGKILL in its own window K = KILL_CONFIRM_MS, counted from the SIGKILL, for every grace (design 2.4, point 1)', () => {
  it.each(GRACES)('grace %i: a group that ends 1000 ms after its SIGKILL is killed, not unconfirmed', async (graceMs) => {
    const group = ignoresTerm(1000);
    expect(await terminateGroup(PGID, { graceMs, port: group.port, timing: group.timing })).toBe('killed');
    expect(group.killedAt()).toBe(graceMs);
  });

  it.each(GRACES)('grace %i: a group that ends one poll before the window closes is killed', async (graceMs) => {
    const group = ignoresTerm(KILL_CONFIRM_MS - POLL_MS);
    expect(await terminateGroup(PGID, { graceMs, port: group.port, timing: group.timing })).toBe('killed');
  });

  it.each(GRACES)('grace %i: a group that outlives the window is reported unconfirmed, and the wait after SIGKILL is K, not the grace', async (graceMs) => {
    const group = ignoresTerm(undefined);
    expect(await terminateGroup(PGID, { graceMs, port: group.port, timing: group.timing })).toBe('unconfirmed');
    const killedAt = group.killedAt();
    expect(group.termAt()).toBe(0);
    expect(killedAt).toBe(graceMs);
    const afterKill = group.now() - (killedAt ?? Number.NaN);
    expect(afterKill).toBeGreaterThanOrEqual(KILL_CONFIRM_MS);
    expect(afterKill).toBeLessThanOrEqual(KILL_CONFIRM_MS + POLL_MS);
  });

  it.each(GRACES)('grace %i: groupTerminationBoundMs is the grace plus K', (graceMs) => {
    expect(groupTerminationBoundMs(graceMs)).toBe(graceMs + KILL_CONFIRM_MS);
  });
});
