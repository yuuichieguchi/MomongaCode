import { describe, expect, it } from 'vitest';
import { signalUntil } from '../../src/memory/deadline-signal.ts';

const aborted = async (signal: AbortSignal): Promise<boolean> => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  return signal.aborted;
};

describe('signalUntil', () => {
  it('aborts when the deadline has passed', async () => {
    expect(await aborted(signalUntil(1_000, 1_000, new AbortController().signal))).toBe(true);
  });

  it('aborts when the parent aborts before the deadline', () => {
    const parent = new AbortController();
    const signal = signalUntil(1_000_000_000, 0, parent.signal);
    expect(signal.aborted).toBe(false);
    parent.abort();
    expect(signal.aborted).toBe(true);
  });

  it('stays open for a deadline further away than a timer can wait, instead of firing at once', async () => {
    expect(await aborted(signalUntil(Number.MAX_SAFE_INTEGER, 0, new AbortController().signal))).toBe(false);
    expect(await aborted(signalUntil(Number.POSITIVE_INFINITY, 0, new AbortController().signal))).toBe(false);
  });
});
