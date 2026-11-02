import { describe, expect, it } from 'vitest';
import { COMMAND_PREFIX_SUFFIX, hasBalancedParentheses } from '@momonga/config';

describe('rule lexemes exported by config (DUP-8)', () => {
  it('spells the prefix suffix once', () => {
    expect(COMMAND_PREFIX_SUFFIX).toBe(':*');
  });

  it.each([
    ['', true],
    ['a(b)c', true],
    ['(a(b))', true],
    ['a)b(', false],
    ['(a', false],
    ['a)', false],
  ])('hasBalancedParentheses(%j) is %s', (value, expected) => {
    expect(hasBalancedParentheses(value)).toBe(expected);
  });
});
