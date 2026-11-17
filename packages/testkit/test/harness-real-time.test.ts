import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers, driveFakeTime, waitFor } from '@momonga/testkit';

describe('waitFor is bounded by real time and yields to real I/O', () => {
  it('gives up after its bound, naming the bound and the description', async () => {
    await expect(waitFor(() => false, { boundMs: 200, description: 'never' })).rejects.toThrow(/not met within 200 ms: never/);
  });

  it('reads its bound from the timing it is given, so the wait ends at the bound of that clock', async () => {
    const clock = createFakeClock(0);
    let polls = 0;
    await expect(
      waitFor(
        () => {
          polls += 1;
          clock.advance(50);
          return false;
        },
        { boundMs: 200, description: 'never', timing: clock },
      ),
    ).rejects.toThrow(/not met within 200 ms: never/);
    expect(polls).toBe(4);
  });

  it('is met by a condition that real I/O settles later than a count of turns would allow', async () => {
    let arrived = false;
    setTimeout(() => {
      arrived = true;
    }, 1000);
    await waitFor(() => arrived);
    expect(arrived).toBe(true);
  });
});

describe('driveFakeTime is bounded by real time, not by steps', () => {
  it('is met by real I/O that completes after a budget of 1000 steps would have ended the wait', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    let arrived = false;
    setTimeout(() => {
      arrived = true;
    }, 1000);

    await driveFakeTime(timers, { done: () => arrived, horizonAt: 90_000, description: 'the I/O' });

    expect(arrived).toBe(true);
  });
});
