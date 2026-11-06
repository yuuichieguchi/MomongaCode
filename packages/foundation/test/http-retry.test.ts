import { describe, expect, it } from 'vitest';
import { TRANSIENT_REQUEST_STATUSES, isRetryableHttp, parseShouldRetry } from '../src/http-retry.ts';

describe('parseShouldRetry', () => {
  it('reads true and false and nothing else', () => {
    expect(parseShouldRetry('true')).toBe(true);
    expect(parseShouldRetry('false')).toBe(false);
    expect(parseShouldRetry(undefined)).toBeUndefined();
    expect(parseShouldRetry('maybe')).toBeUndefined();
  });
});

describe('isRetryableHttp', () => {
  it('lets the status decide only when the target reports nothing', () => {
    for (const status of [408, 409, 429, 500, 503]) expect(isRetryableHttp(status, undefined)).toBe(true);
    for (const status of [400, 401, 403, 404, 413, 422]) expect(isRetryableHttp(status, undefined)).toBe(false);
  });

  it('lets the report of the target decide for every status', () => {
    for (const status of [400, 401, 408, 409, 413, 429, 500, 503]) {
      expect(isRetryableHttp(status, true)).toBe(true);
      expect(isRetryableHttp(status, false)).toBe(false);
    }
  });

  it('names 408 and 409 as the transient request statuses', () => {
    expect([...TRANSIENT_REQUEST_STATUSES]).toEqual([408, 409]);
  });
});
