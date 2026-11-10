import { describe, expect, it } from 'vitest';
import { isRecord } from '@momonga/foundation';

describe('isRecord', () => {
  it('accepts a plain object and rejects null, an array and a primitive', () => {
    expect(isRecord({ key: 1 })).toBe(true);
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('text')).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});
