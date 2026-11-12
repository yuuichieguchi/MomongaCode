import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import { signalUntil } from '../../src/memory/deadline-signal.ts';
import { reapTimingOf } from '../../src/process/reap-timing.ts';

const fakeTiming = (startMs: number) => {
  const clock = createFakeClock(startMs);
  const timers = createFakeTimers(clock);
  return { timers, timing: reapTimingOf(clock, timers) };
};

describe('signalUntil', () => {
  it('aborts at once when the deadline has passed', () => {
    const { timing } = fakeTiming(1_000);
    expect(signalUntil(timing, 1_000, new AbortController().signal).signal.aborted).toBe(true);
  });

  it('aborts when the timers of the timing port reach the deadline, and not before', () => {
    const { timers, timing } = fakeTiming(0);
    const { signal } = signalUntil(timing, 500, new AbortController().signal);
    timers.advance(499);
    expect(signal.aborted).toBe(false);
    timers.advance(1);
    expect(signal.aborted).toBe(true);
  });

  it('aborts when the parent aborts before the deadline', () => {
    const { timing } = fakeTiming(0);
    const parent = new AbortController();
    const { signal } = signalUntil(timing, 1_000_000_000, parent.signal);
    expect(signal.aborted).toBe(false);
    parent.abort();
    expect(signal.aborted).toBe(true);
  });

  it('stays open for a deadline further away than a timer can wait, instead of firing at once', () => {
    const { timers, timing } = fakeTiming(0);
    const far = signalUntil(timing, Number.MAX_SAFE_INTEGER, new AbortController().signal);
    const endless = signalUntil(timing, Number.POSITIVE_INFINITY, new AbortController().signal);
    timers.advance(1);
    expect(far.signal.aborted).toBe(false);
    expect(endless.signal.aborted).toBe(false);
  });

  it('leaves no timer behind once disposed', () => {
    const { timers, timing } = fakeTiming(0);
    signalUntil(timing, 500, new AbortController().signal).dispose();
    expect(timers.pending()).toEqual([]);
  });
});
