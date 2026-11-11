import { describe, expect, it } from 'vitest';
import { KILL_CONFIRM_MS, forceKillGroup, terminateGroup, waitForGroupGone } from '../src/index.ts';
import type { ProcessGroupPort, Timing } from '../src/index.ts';
import { createFakeClock, createSteppingTiming } from '@momonga/testkit';

const PGID = 4321;
const GRACE_MS = 300;

type World = { port: ProcessGroupPort; timing: Timing; sent: Array<{ signal: NodeJS.Signals; at: number }>; probes(): number; now(): number };

const worldOf = (signals: ProcessGroupPort['signals'], diesOn: NodeJS.Signals | undefined): World => {
  const clock = createFakeClock(0);
  let alive = true;
  let probes = 0;
  const sent: World['sent'] = [];
  return {
    sent,
    probes: () => probes,
    now: () => clock.now(),
    timing: createSteppingTiming(clock),
    port: {
      ...(signals === undefined ? {} : { signals }),
      signal: async (_pgid, signal) => {
        sent.push({ signal, at: clock.now() });
        if (signal === diesOn) alive = false;
      },
      alive: async () => {
        probes += 1;
        return alive;
      },
    },
  };
};

describe('T-JO-9: the signals a port reports drive the stop procedure', () => {
  it('a port with one signal does exactly one signal phase: one attempt, the confirmation wait of at most the grace, then unconfirmed', async () => {
    const world = worldOf(['SIGTERM'], undefined);
    expect(await terminateGroup(PGID, { graceMs: GRACE_MS, port: world.port, timing: world.timing })).toBe('unconfirmed');
    expect(world.sent).toEqual([{ signal: 'SIGTERM', at: 0 }]);
    expect(world.now()).toBeGreaterThanOrEqual(GRACE_MS);
    expect(world.now()).toBeLessThan(GRACE_MS + KILL_CONFIRM_MS);
  });

  it('a port with one signal ends terminated when its one signal empties the group', async () => {
    const world = worldOf(['SIGTERM'], 'SIGTERM');
    expect(await terminateGroup(PGID, { graceMs: GRACE_MS, port: world.port, timing: world.timing })).toBe('terminated');
    expect(world.sent.map(({ signal }) => signal)).toEqual(['SIGTERM']);
  });

  it('a port with two signals sends the first, waits the grace, then repeats the last until the confirmation window ends', async () => {
    const world = worldOf(['SIGTERM', 'SIGKILL'], 'SIGKILL');
    expect(await terminateGroup(PGID, { graceMs: GRACE_MS, port: world.port, timing: world.timing })).toBe('killed');
    expect(world.sent[0]).toEqual({ signal: 'SIGTERM', at: 0 });
    expect(world.sent[1]?.signal).toBe('SIGKILL');
    expect(world.sent[1]?.at).toBeGreaterThanOrEqual(GRACE_MS);
  });

  it('a port that states no signals is a POSIX group: SIGTERM, then SIGKILL', async () => {
    const world = worldOf(undefined, 'SIGKILL');
    expect(await terminateGroup(PGID, { graceMs: GRACE_MS, port: world.port, timing: world.timing })).toBe('killed');
    expect(world.sent.map(({ signal }) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('the forced phase sends the last signal of the port, whatever its name', async () => {
    const world = worldOf(['SIGINT', 'SIGTERM', 'SIGQUIT'], 'SIGQUIT');
    expect(await forceKillGroup(PGID, { deadline: 1000, port: world.port, timing: world.timing })).toBe(true);
    expect(world.sent.map(({ signal }) => signal)).toEqual(['SIGQUIT']);
  });
});

describe('a port that can push the end of its group is not polled', () => {
  it('waits for the pushed end and probes once before and once after it', async () => {
    let alive = true;
    let probes = 0;
    let pushEnd: () => void = () => undefined;
    const sleeps: number[] = [];
    const port: ProcessGroupPort = {
      signals: ['SIGTERM'],
      signal: async () => undefined,
      alive: async () => {
        probes += 1;
        return alive;
      },
      ended: () => new Promise<void>((resolve) => (pushEnd = resolve)),
    };
    const timing: Timing = { now: () => 0, monotonicMs: () => 0, setTimeout: (_wake, ms) => void sleeps.push(ms), clearTimeout: () => undefined };
    const waited = waitForGroupGone(PGID, 5000, port, timing);
    for (let round = 0; round < 20; round += 1) await Promise.resolve();
    expect(probes).toBe(1);
    expect(sleeps).toEqual([5000]);
    alive = false;
    pushEnd();
    expect(await waited).toBe(true);
    expect(probes).toBe(2);
  });

  it('gives up at the deadline when no end is pushed, with one sleep to the deadline and no poll', async () => {
    let probes = 0;
    const port: ProcessGroupPort = {
      signals: ['SIGTERM'],
      signal: async () => undefined,
      alive: async () => {
        probes += 1;
        return true;
      },
      ended: (_pgid, { signal }) => new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })),
    };
    const timing = createSteppingTiming(createFakeClock(0));
    expect(await waitForGroupGone(PGID, 700, port, timing)).toBe(false);
    expect(timing.sleeps).toEqual([700]);
    expect(probes).toBe(2);
  });
});
