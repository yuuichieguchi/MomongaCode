import { describe, expect, it } from 'vitest';
import { safeSlice } from '@momonga/foundation';

const PAIR = '\u{1F600}';

describe('safeSlice', () => {
  it('slices plain text like String.prototype.slice', () => {
    expect(safeSlice('abcdef', 1, 4)).toBe('bcd');
  });

  it('drops a high surrogate left alone at the end', () => {
    expect(safeSlice(`ab${PAIR}`, 0, 3)).toBe('ab');
  });

  it('drops a low surrogate left alone at the start', () => {
    expect(safeSlice(`${PAIR}ab`, 1, 4)).toBe('ab');
  });

  it('keeps a whole pair at either end', () => {
    expect(safeSlice(`${PAIR}ab${PAIR}`, 0, 6)).toBe(`${PAIR}ab${PAIR}`);
  });
});
