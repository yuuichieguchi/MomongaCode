import { describe, expect, it } from 'vitest';
import { REPLAY_PAGE_EVENTS, createReplayQueue } from '../../src/tui/replay.ts';
import { manualClock } from './screen-clock.ts';
import { turnTimers } from './turn-timers.ts';

describe('the replay queue (9.2, 14.2)', () => {
  it('does at most one page of 500 events per event-loop turn, in order, and reports the position after each page', async () => {
    const clock = turnTimers(manualClock());
    const pages: number[] = [];
    const done: number[] = [];
    const queue = createReplayQueue(clock.timers, (position) => void pages.push(position));
    for (let seq = 1; seq <= 1200; seq += 1) queue.push(() => void done.push(seq), seq);
    const drained = queue.drained();

    expect(REPLAY_PAGE_EVENTS).toBe(500);
    expect(done).toEqual([]);
    clock.turn();
    expect(done.length).toBe(500);
    expect(pages).toEqual([500]);
    clock.turn();
    expect(done.length).toBe(1000);
    clock.turn();
    expect(done).toEqual(Array.from({ length: 1200 }, (_, index) => index + 1));
    expect(pages).toEqual([500, 1000, 1200]);
    expect(clock.waiting()).toBe(0);
    await drained;
  });

  it('is drained at once when nothing waits, and starts again for work pushed later', async () => {
    const clock = turnTimers(manualClock());
    const done: string[] = [];
    const queue = createReplayQueue(clock.timers, () => undefined);

    await queue.drained();
    queue.push(() => void done.push('later'));
    clock.turn();
    expect(done).toEqual(['later']);
    await queue.drained();
  });

  it('fails the wait with the error of the work that threw and does none of the rest', async () => {
    const clock = turnTimers(manualClock());
    const done: string[] = [];
    const queue = createReplayQueue(clock.timers, () => undefined);
    queue.push(() => {
      throw new Error('fold failed');
    });
    queue.push(() => void done.push('after'));
    const drained = queue.drained();
    clock.turn();

    await expect(drained).rejects.toThrow('fold failed');
    expect(done).toEqual([]);
  });
});
