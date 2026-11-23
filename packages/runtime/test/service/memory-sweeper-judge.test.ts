import { describe, expect, it } from 'vitest';
import { afterMicrotasks, createFakeClock, createFakeTimers } from '@momonga/testkit';
import { START_MS } from '../../../store/test/helpers.ts';
import { startMemorySweeper } from '../../src/service/memory-sweeper.ts';

const start = (options: Record<string, unknown>) => startMemorySweeper(options as unknown as Parameters<typeof startMemorySweeper>[0]);

describe('the memory sweeper judges after it reflects', () => {
  it('runs upkeep, reflect and judge in that order on every tick', async () => {
    const timers = createFakeTimers(createFakeClock(START_MS));
    const seen: string[] = [];
    const sweeper = start({
      timers,
      intervalMs: 1000,
      upkeep: async () => void seen.push('upkeep'),
      reflect: async () => void seen.push('reflect'),
      judge: async () => void seen.push('judge'),
      onError: () => undefined,
    });
    timers.advance(1000);
    await afterMicrotasks();
    timers.advance(1000);
    await afterMicrotasks();
    expect(seen).toEqual(['upkeep', 'reflect', 'judge', 'upkeep', 'reflect', 'judge']);
    await sweeper.close();
  });

  it.each(['upkeep', 'reflect', 'judge'] as const)('keeps the other work running when %s fails, and reports the error', async (failing) => {
    const timers = createFakeTimers(createFakeClock(START_MS));
    const seen: string[] = [];
    const errors: unknown[] = [];
    const failure = new Error(`${failing} failed`);
    const work = (name: string) => async () => {
      seen.push(name);
      if (name === failing) throw failure;
    };
    const sweeper = start({ timers, intervalMs: 1000, upkeep: work('upkeep'), reflect: work('reflect'), judge: work('judge'), onError: (error: unknown) => errors.push(error) });
    timers.advance(1000);
    await afterMicrotasks();
    timers.advance(1000);
    await afterMicrotasks();
    expect(seen).toEqual(['upkeep', 'reflect', 'judge', 'upkeep', 'reflect', 'judge']);
    expect(errors).toEqual([failure, failure]);
    await sweeper.close();
  });

  it('passes the close signal to the judge and reports no error when the judge stops for it', async () => {
    const timers = createFakeTimers(createFakeClock(START_MS));
    const errors: unknown[] = [];
    const signals: AbortSignal[] = [];
    const sweeper = start({
      timers,
      intervalMs: 1000,
      upkeep: async () => undefined,
      reflect: async () => undefined,
      judge: (signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signals.push(signal);
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
      onError: (error: unknown) => errors.push(error),
    });
    timers.advance(1000);
    await afterMicrotasks();
    expect(signals).toHaveLength(1);
    await sweeper.close();
    expect(signals[0]?.aborted).toBe(true);
    expect(errors).toEqual([]);
    expect(timers.pending()).toEqual([]);
  });
});
