import { describe, expect, it } from 'vitest';
import { isRecord, parseJsonOrText } from '@momonga/foundation';

describe('parseJsonOrText', () => {
  it('returns the parsed value for valid JSON', () => {
    expect(parseJsonOrText('{"a":[1,2]}')).toEqual({ a: [1, 2] });
    expect(parseJsonOrText('7')).toBe(7);
  });

  it('returns the original text when it is not valid JSON', () => {
    expect(parseJsonOrText('{not json')).toBe('{not json');
    expect(parseJsonOrText('')).toBe('');
  });
});

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
