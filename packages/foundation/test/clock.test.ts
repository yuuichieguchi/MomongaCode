import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { systemClock } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';

afterEach(() => {
  vi.useRealTimers();
});

describe('systemClock', () => {
  it('has the Clock shape', () => {
    expectTypeOf<Clock>().toEqualTypeOf<{ now(): number }>();
    expectTypeOf(systemClock).toExtend<Clock>();
  });

  it('reads the system time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(123_456);
    expect(systemClock.now()).toBe(123_456);
  });
});
