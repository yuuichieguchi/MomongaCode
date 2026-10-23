import { describe, expect, it } from 'vitest';
import { ProcessLockHeldError } from '@momonga/foundation';
import { RUNTIME_ABORT_BUDGET_MS, RUNTIME_TEARDOWN_BUDGET_MS, RuntimeAlreadyRunningError, runtimeMaxCloseMs } from '@momonga/runtime';

describe('runtime lifecycle exports (system timers, none used)', () => {
  it('the abort budget is 5000 ms and the teardown budget is 10000 ms', () => {
    expect(RUNTIME_ABORT_BUDGET_MS).toBe(5000);
    expect(RUNTIME_TEARDOWN_BUDGET_MS).toBe(10000);
  });

  it.each([
    [0, 15000],
    [1, 15001],
    [30000, 45000],
  ])('runtimeMaxCloseMs(%i) is d + 5000 + 10000 = %i', (drainTimeoutMs, expected) => {
    expect(runtimeMaxCloseMs(drainTimeoutMs)).toBe(expected);
  });

  it('RuntimeAlreadyRunningError extends ProcessLockHeldError', () => {
    expect(Object.getPrototypeOf(RuntimeAlreadyRunningError)).toBe(ProcessLockHeldError);
  });

  it('a RuntimeAlreadyRunningError is a ProcessLockHeldError carrying lockPath and holderPid', () => {
    const error = new RuntimeAlreadyRunningError('runtime already running', '/tmp/h/.momonga/run/runtime.lock', 4242);

    expect(error).toBeInstanceOf(RuntimeAlreadyRunningError);
    expect(error).toBeInstanceOf(ProcessLockHeldError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RuntimeAlreadyRunningError');
    expect(error.lockPath).toBe('/tmp/h/.momonga/run/runtime.lock');
    expect(error.holderPid).toBe(4242);
    expect(error.message).toBe('runtime already running');
  });
});
