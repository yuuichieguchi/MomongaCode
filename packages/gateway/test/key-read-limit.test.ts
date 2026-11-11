import { describe, expect, it } from 'vitest';
import { HOST_READ_BOUND_MS } from '@momonga/foundation';
import { keyReadLimitOf } from '../src/key-read-limit.ts';

describe('the key read of a target waits under the request limit', () => {
  it('bounds the read by the request limit the settings give, however small', () => {
    expect(keyReadLimitOf(1)).toEqual({ limitMs: 1, label: 'the request limit' });
    expect(keyReadLimitOf(HOST_READ_BOUND_MS + 1)).toEqual({ limitMs: HOST_READ_BOUND_MS + 1, label: 'the request limit' });
  });

  it('gives no value a special meaning', () => {
    expect(keyReadLimitOf(0)).toEqual({ limitMs: 0, label: 'the request limit' });
  });
});
