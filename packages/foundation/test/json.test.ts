import { describe, expect, it } from 'vitest';
import { parseJsonOrText } from '@momonga/foundation';

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
