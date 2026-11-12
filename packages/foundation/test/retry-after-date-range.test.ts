import { describe, expect, it } from 'vitest';
import { MAX_DATE_MS, parseRetryAfter } from '@momonga/foundation';

describe('a retry delay stays in the range of a Date', () => {
  it('is bounded by the ECMAScript time value range', () => {
    expect(MAX_DATE_MS).toBe(8.64e15);
  });

  it('gives no delay for a Retry-After past the range and keeps one inside it', () => {
    expect(parseRetryAfter('9000000000000', 0)).toBeUndefined();
    expect(parseRetryAfter('8000000000000', 0)).toBe(8_000_000_000_000_000);
    expect(parseRetryAfter(String(MAX_DATE_MS / 1000), 0)).toBe(MAX_DATE_MS);
    expect(parseRetryAfter(String(MAX_DATE_MS / 1000 + 1), 0)).toBeUndefined();
  });
});
