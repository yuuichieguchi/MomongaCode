import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationLimitError, operationLimit, settledOrAborted } from '@momonga/foundation';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import { deferred, rejection, settlementOf, turn, unhandledRejections } from './support/secret-store-fakes.ts';

const fakeTiming = () => createFakeTimers(createFakeClock(0));

afterEach(() => {
  vi.useRealTimers();
});

describe('operationLimit', () => {
  it('aborts with an OperationLimitError carrying the limit when the time passes', () => {
    const timing = fakeTiming();
    const limit = operationLimit(new AbortController().signal, 300000, 'the command limit', timing);
    expect(timing.pending().map((timer) => timer.delayMs)).toEqual([300000]);
    timing.advance(299999);
    expect(limit.signal.aborted).toBe(false);
    timing.advance(1);
    expect(limit.signal.aborted).toBe(true);
    const reason: unknown = limit.signal.reason;
    expect(reason).toBeInstanceOf(OperationLimitError);
    expect(reason).toBeInstanceOf(Error);
    expect((reason as OperationLimitError).name).toBe('OperationLimitError');
    expect((reason as OperationLimitError).limitMs).toBe(300000);
    expect((reason as OperationLimitError).label).toBe('the command limit');
    expect((reason as OperationLimitError).message).toBe('the command limit of 300000 ms passed');
  });

  it('the error states its limit in its message', () => {
    const error = new OperationLimitError(30000, 'the MCP connect limit');
    expect(error.message).toBe('the MCP connect limit of 30000 ms passed');
    expect({ name: error.name, limitMs: error.limitMs, label: error.label }).toEqual({ name: 'OperationLimitError', limitMs: 30000, label: 'the MCP connect limit' });
  });

  it("aborts with the parent's reason itself when the parent aborts first", () => {
    const timing = fakeTiming();
    const parent = new AbortController();
    const limit = operationLimit(parent.signal, 300000, 'the command limit', timing);
    const parentReason = new Error('interrupted by the user');
    parent.abort(parentReason);
    expect(limit.signal.aborted).toBe(true);
    expect(limit.signal.reason).toBe(parentReason);
    expect(timing.pending()).toEqual([]);
    timing.advance(300000);
    expect(limit.signal.reason).toBe(parentReason);
  });

  it("an already aborted parent gives an aborted signal with the parent's reason and arms no timer", () => {
    const timing = fakeTiming();
    const parent = new AbortController();
    const parentReason = new Error('already gone');
    parent.abort(parentReason);
    const limit = operationLimit(parent.signal, 300000, 'the command limit', timing);
    expect(limit.signal.aborted).toBe(true);
    expect(limit.signal.reason).toBe(parentReason);
    expect(timing.pending()).toEqual([]);
  });

  it('dispose clears the timer and never aborts', () => {
    const timing = fakeTiming();
    const parent = new AbortController();
    const limit = operationLimit(parent.signal, 300000, 'the command limit', timing);
    limit.dispose();
    expect(timing.pending()).toEqual([]);
    expect(limit.signal.aborted).toBe(false);
    timing.advance(300000);
    expect(limit.signal.aborted).toBe(false);
    parent.abort(new Error('later'));
    expect(limit.signal.aborted).toBe(false);
    limit.dispose();
    expect(limit.signal.aborted).toBe(false);
  });

  it.for([0, 1.5, 2147483648, Number.NaN])('rejects a limit outside 1 to 2147483647 (%s)', (limitMs) => {
    const timing = fakeTiming();
    expect(() => operationLimit(new AbortController().signal, limitMs, 'the command limit', timing)).toThrow(RangeError);
    expect(timing.pending()).toEqual([]);
  });

  it.for([1, 2147483647])('accepts the limit %s at the edge of the range', (limitMs) => {
    const timing = fakeTiming();
    const limit = operationLimit(new AbortController().signal, limitMs, 'the command limit', timing);
    expect(timing.pending().map((timer) => timer.delayMs)).toEqual([limitMs]);
    limit.dispose();
  });

  it('uses the system timing when none is given, which the fake timers of a test drive', () => {
    vi.useFakeTimers();
    const limit = operationLimit(new AbortController().signal, 1000, 'the command limit');
    vi.advanceTimersByTime(999);
    expect(limit.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(limit.signal.reason).toBeInstanceOf(OperationLimitError);
  });
});

describe('settledOrAborted', () => {
  it('resolves and rejects like the pending promise while the signal is not aborted', async () => {
    const signal = new AbortController().signal;
    await expect(settledOrAborted(Promise.resolve('value'), signal)).resolves.toBe('value');
    const failure = new Error('the stat failed');
    await expect(settledOrAborted(Promise.reject(failure), signal)).rejects.toBe(failure);
  });

  it("settledOrAborted rejects with the signal's reason when the signal aborts first, ignores a later settlement and swallows a late rejection", async () => {
    const unhandled = unhandledRejections();
    try {
      const resolvedLate = deferred<string>();
      const rejectedLate = deferred<string>();
      const controller = new AbortController();
      const first = settledOrAborted(resolvedLate.promise, controller.signal);
      const second = settledOrAborted(rejectedLate.promise, controller.signal);
      const firstSettlement = settlementOf(first);
      await turn();
      expect(firstSettlement.current()).toBe('pending');
      const reason = new Error('the limit passed');
      controller.abort(reason);
      expect(await rejection(first)).toBe(reason);
      expect(await rejection(second)).toBe(reason);
      resolvedLate.resolve('late value');
      rejectedLate.reject(new Error('late failure'));
      await turn();
      await turn();
      expect(firstSettlement.current()).toEqual({ rejected: reason });
      expect(unhandled.seen).toEqual([]);
    } finally {
      unhandled.stop();
    }
  });

  it('rejects at once when the signal is already aborted, whatever the pending promise does', async () => {
    const unhandled = unhandledRejections();
    try {
      const controller = new AbortController();
      const reason = new Error('already gone');
      controller.abort(reason);
      const never = deferred<string>();
      expect(await rejection(settledOrAborted(never.promise, controller.signal))).toBe(reason);
      never.reject(new Error('late failure'));
      await turn();
      await turn();
      expect(unhandled.seen).toEqual([]);
    } finally {
      unhandled.stop();
    }
  });
});
