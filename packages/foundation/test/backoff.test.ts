import { describe, expect, it } from 'vitest';
import { computeBackoff, parseRetryAfter } from '@momonga/foundation';

describe('computeBackoff', () => {
  it('returns 0 when the random source returns 0', () => {
    expect(computeBackoff({ attempt: 3, baseMs: 100, maxMs: 10_000, random: () => 0 })).toBe(0);
  });

  it('stays within the exponential cap baseMs * 2^attempt', () => {
    const almostOne = () => 0.999_999_999;
    expect(computeBackoff({ attempt: 0, baseMs: 100, maxMs: 10_000, random: almostOne })).toBeLessThanOrEqual(100);
    expect(computeBackoff({ attempt: 0, baseMs: 100, maxMs: 10_000, random: almostOne })).toBeGreaterThanOrEqual(99);
    expect(computeBackoff({ attempt: 3, baseMs: 100, maxMs: 10_000, random: almostOne })).toBeLessThanOrEqual(800);
    expect(computeBackoff({ attempt: 3, baseMs: 100, maxMs: 10_000, random: almostOne })).toBeGreaterThanOrEqual(799);
  });

  it('scales linearly with the random draw (full jitter)', () => {
    const half = computeBackoff({ attempt: 3, baseMs: 100, maxMs: 10_000, random: () => 0.5 });
    expect(half).toBeGreaterThanOrEqual(399);
    expect(half).toBeLessThanOrEqual(401);
  });

  it('never exceeds maxMs, even for huge attempts', () => {
    for (const attempt of [7, 20, 1000, 5000]) {
      const value = computeBackoff({ attempt, baseMs: 100, maxMs: 10_000, random: () => 0.999_999_999 });
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeLessThanOrEqual(10_000);
      expect(value).toBeGreaterThanOrEqual(9_999);
    }
  });

  it('returns integer milliseconds', () => {
    expect(Number.isInteger(computeBackoff({ attempt: 2, baseMs: 100, maxMs: 10_000, random: () => 0.123 }))).toBe(true);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.UTC(2015, 9, 21, 7, 27, 30);

  it('parses delta-seconds into milliseconds', () => {
    expect(parseRetryAfter('5', now)).toBe(5000);
    expect(parseRetryAfter('0', now)).toBe(0);
    expect(parseRetryAfter('120', now)).toBe(120_000);
  });

  it('parses an HTTP-date relative to now', () => {
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', now)).toBe(30_000);
  });

  it('clamps past HTTP-dates to 0', () => {
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:00:00 GMT', now)).toBe(0);
  });

  it('returns undefined for garbage, negatives, fractions and absence', () => {
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter('-1', now)).toBeUndefined();
    expect(parseRetryAfter('1.5', now)).toBeUndefined();
    expect(parseRetryAfter('', now)).toBeUndefined();
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it('returns undefined when the delay is not a safe integer', () => {
    expect(parseRetryAfter('9'.repeat(400), now)).toBeUndefined();
    expect(parseRetryAfter('9'.repeat(16), now)).toBeUndefined();
  });
});
