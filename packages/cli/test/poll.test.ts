import { describe, expect, it } from 'vitest';
import { PollTimeout, pollUntil } from '../src/poll.ts';
import type { CliClock } from '../src/ports.ts';

const virtualClock = (): CliClock & { slept: number[] } => {
  let now = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
  };
};

describe('pollUntil', () => {
  it('returns the first defined value without sleeping when the probe succeeds at once', async () => {
    const clock = virtualClock();
    expect(await pollUntil(clock, async () => 'ready', { boundMs: 100, intervalMs: 10, description: 'x' })).toBe('ready');
    expect(clock.slept).toEqual([]);
  });

  it('polls at the interval until the probe answers', async () => {
    const clock = virtualClock();
    let calls = 0;
    const value = await pollUntil(clock, async () => (++calls === 4 ? calls : undefined), { boundMs: 1000, intervalMs: 10, description: 'x' });
    expect(value).toBe(4);
    expect(clock.slept).toEqual([10, 10, 10]);
  });

  it('fails with PollTimeout when the bound passes, and never sleeps past it', async () => {
    const clock = virtualClock();
    await expect(pollUntil(clock, async () => undefined, { boundMs: 25, intervalMs: 10, description: 'the thing' })).rejects.toEqual(
      expect.objectContaining({ name: 'PollTimeout', message: 'timed out after 25 ms waiting for the thing' }),
    );
    expect(clock.slept).toEqual([10, 10, 5]);
    expect(PollTimeout.name).toBe('PollTimeout');
  });

  it('lets a probe failure propagate instead of retrying it', async () => {
    await expect(
      pollUntil(virtualClock(), async () => {
        throw new Error('deterministic');
      }, { boundMs: 100, intervalMs: 10, description: 'x' }),
    ).rejects.toThrow('deterministic');
  });

  it('stops when the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('interrupted'));
    await expect(pollUntil(virtualClock(), async () => undefined, { boundMs: 100, intervalMs: 10, description: 'x', signal: controller.signal })).rejects.toThrow('interrupted');
  });
});

describe('pollUntil with a progress mark', () => {
  it('keeps waiting past the bound in total while the mark changes within each bound, and answers when the probe does', async () => {
    const clock = virtualClock();
    const value = await pollUntil(clock, async () => (clock.now() >= 300 ? 'ready' : undefined), {
      boundMs: 100,
      intervalMs: 10,
      description: 'x',
      progressMark: () => String(Math.floor(clock.now() / 80)),
    });
    expect(value).toBe('ready');
  });

  it('gives up one bound after the last change of the mark', async () => {
    const clock = virtualClock();
    await expect(
      pollUntil(clock, async () => undefined, { boundMs: 100, intervalMs: 10, description: 'the thing', progressMark: () => (clock.now() < 150 ? String(clock.now()) : 'stalled') }),
    ).rejects.toEqual(expect.objectContaining({ name: 'PollTimeout' }));
    expect(clock.now()).toBe(250);
  });
});
