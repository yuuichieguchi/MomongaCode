import { describe, expect, expectTypeOf, it } from 'vitest';
import type { StartTime } from '@momonga/foundation';
import * as windowsParsers from '../../src/platform/windows-parsers.ts';

describe('the Windows start-time parser names no unit, because StartTime is one type on every platform (design 19.6 point 14)', () => {
  it('is exported as parseStartTime and not as parseStartTimeMs', () => {
    expect(Object.keys(windowsParsers)).toContain('parseStartTime');
    expect(Object.keys(windowsParsers)).not.toContain('parseStartTimeMs');
  });

  it('returns StartTime or undefined', () => {
    expectTypeOf(windowsParsers.parseStartTime).returns.toEqualTypeOf<StartTime | undefined>();
    expect(windowsParsers.parseStartTime('133000000000000000')).toBe(133_000_000_000_000_000n);
    expect(windowsParsers.parseStartTime('')).toBeUndefined();
  });
});
