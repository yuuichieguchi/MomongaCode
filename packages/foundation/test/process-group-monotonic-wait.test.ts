import { describe, expect, it } from 'vitest';
import { terminateGroup, waitForGroupGone } from '@momonga/foundation';
import type { ProcessGroupPort, Timing } from '@momonga/foundation';
import { createFakeClock, createFakeTimers, createSteppingTiming } from '@momonga/testkit';

const ONE_HOUR_MS = 3_600_000;

const GROUP = 4242;

interface EndingGroup {
  readonly port: ProcessGroupPort;
  end(): void;
}

const groupWithPushedEnd = (): EndingGroup => {
  let alive = true;
  const ended = Promise.withResolvers<void>();
  return {
    port: { signal: async () => 'sent' as const, alive: async () => alive, ended: () => ended.promise },
    end: () => {
      alive = false;
      ended.resolve();
    },
  };
};

describe('the wait for a process group leaves no timer behind', () => {
  it('clears the timer of its bound when the pushed end of the group wins', async () => {
    const timers = createFakeTimers(createFakeClock(0));
    const group = groupWithPushedEnd();
    const gone = waitForGroupGone(GROUP, timers.monotonicMs() + 5000, group.port, timers);
    await expect.poll(() => timers.pending().length).toBe(1);
    group.end();
    expect(await gone).toBe(true);
    expect(timers.pending()).toEqual([]);
  });

  it('clears the timer of its bound when the asker leaves', async () => {
    const timers = createFakeTimers(createFakeClock(0));
    const group = groupWithPushedEnd();
    const stop = new AbortController();
    const gone = waitForGroupGone(GROUP, timers.monotonicMs() + 5000, group.port, timers, stop.signal);
    await expect.poll(() => timers.pending().length).toBe(1);
    stop.abort();
    expect(await gone).toBe(false);
    expect(timers.pending()).toEqual([]);
  });

  it('clears the timer of a poll when the asker leaves a group that pushes no end', async () => {
    const timers = createFakeTimers(createFakeClock(0));
    const stop = new AbortController();
    const port: ProcessGroupPort = { signal: async () => 'sent' as const, alive: async () => true };
    const gone = waitForGroupGone(GROUP, timers.monotonicMs() + 5000, port, timers, stop.signal);
    await expect.poll(() => timers.pending().length).toBe(1);
    stop.abort();
    expect(await gone).toBe(false);
    expect(timers.pending()).toEqual([]);
  });
});

describe('the grace of a process group is measured on the monotonic clock', () => {
  it('still says terminated when the wall clock steps forward one hour after SIGTERM and the group ends within the grace', async () => {
    const stepping = createSteppingTiming(createFakeClock(0));
    let wallStep = 0;
    let termAt: number | undefined;
    const sent: NodeJS.Signals[] = [];
    const timing: Timing = { ...stepping, now: () => stepping.now() + wallStep };
    const port: ProcessGroupPort = {
      signal: async (_pgid, signal) => {
        sent.push(signal);
        if (signal !== 'SIGTERM') return 'sent' as const;
        termAt = stepping.monotonicMs();
        wallStep = ONE_HOUR_MS;
        return 'sent' as const;
      },
      alive: async () => termAt === undefined || stepping.monotonicMs() - termAt < 500,
    };
    expect(await terminateGroup(GROUP, { graceMs: 1000, port, timing })).toBe('terminated');
    expect(sent).toEqual(['SIGTERM']);
  });
});

describe('the pushed end of a group keeps its failure', () => {
  it('rejects the wait with the error of the pushed end, not a timeout after the bound', async () => {
    const timers = createFakeTimers(createFakeClock(0));
    const failure = Object.assign(new Error('EIO: the end of the group could not be watched'), { code: 'EIO' });
    const port: ProcessGroupPort = { signal: async () => 'sent' as const, alive: async () => true, ended: async () => Promise.reject(failure) };
    await expect(waitForGroupGone(GROUP, timers.monotonicMs() + 5000, port, timers)).rejects.toBe(failure);
    expect(timers.pending()).toEqual([]);
  });

  it('a pushed end that rejects because its asker left is the leave, not a failure', async () => {
    const timers = createFakeTimers(createFakeClock(0));
    const asker = new AbortController();
    const port: ProcessGroupPort = {
      signal: async () => 'sent' as const,
      alive: async () => true,
      ended: (_pgid, { signal }) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })),
    };
    const gone = waitForGroupGone(GROUP, timers.monotonicMs() + 5000, port, timers, asker.signal);
    await expect.poll(() => timers.pending().length).toBe(1);
    asker.abort(new Error('the asker left'));
    expect(await gone).toBe(false);
    expect(timers.pending()).toEqual([]);
  });
});
