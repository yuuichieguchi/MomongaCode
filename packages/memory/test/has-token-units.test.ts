import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_CHARS, hasToken } from '../src/contribution.ts';

const originalSegment = Intl.Segmenter.prototype.segment;

type Counted = { total: number; maxBetweenUnits: number; units: number; result: boolean };

const counted = (text: string, identifier: string): Counted => {
  let total = 0;
  let sinceUnit = 0;
  let maxBetweenUnits = 0;
  let units = 0;
  vi.spyOn(Intl.Segmenter.prototype, 'segment').mockImplementation(function (this: Intl.Segmenter, input: string) {
    total += input.length;
    sinceUnit += input.length;
    return originalSegment.call(this, input);
  });
  const result = hasToken(text, identifier, () => {
    units += 1;
    maxBetweenUnits = Math.max(maxBetweenUnits, sinceUnit);
    sinceUnit = 0;
  });
  vi.restoreAllMocks();
  return { total, maxBetweenUnits: Math.max(maxBetweenUnits, sinceUnit), units, result };
};

const unchunkedHasToken = (text: string, identifier: string): boolean => {
  const segmenter = new Intl.Segmenter('und', { granularity: 'word' });
  for (const { segment, isWordLike } of originalSegment.call(segmenter, text)) if (isWordLike === true && segment === identifier) return true;
  return false;
};

afterEach(() => {
  vi.restoreAllMocks();
});

const SMALL = 8_192;
const LARGE = 65_536;

describe('hasToken bounds the work per unit for repetitive non-ASCII text (review of fd3c85df, finding 1)', () => {
  it('segments at most CHUNK_CHARS characters between two unit() calls, however long the text and however many occurrences it holds', () => {
    for (const n of [SMALL, LARGE]) {
      const { maxBetweenUnits } = counted('あい'.repeat(n / 2), 'あいあ');
      expect(maxBetweenUnits, `${n} characters`).toBeLessThanOrEqual(CHUNK_CHARS);
    }
  });

  it('segments each character of a non-ASCII run a bounded number of times, not once per occurrence', () => {
    for (const n of [SMALL, LARGE]) {
      const { total } = counted('あい'.repeat(n / 2), 'あいあ');
      expect(total, `${n} characters`).toBeLessThanOrEqual(2 * n);
    }
  });

  it('the characters segmented grow linearly with the text, not with the text times the occurrence count', () => {
    const small = counted('あい'.repeat(SMALL / 2), 'あいあ').total;
    const large = counted('あい'.repeat(LARGE / 2), 'あいあ').total;

    expect(large).toBeLessThanOrEqual(2 * (LARGE / SMALL) * Math.max(small, 1));
    expect(large).toBeLessThanOrEqual(2 * LARGE);
  });

  it.each([
    ['repeated syllables that never form the word', 'あい'.repeat(4_096), 'あいあ'],
    ['the word between particles', `${'これは'.repeat(2_000)}設定ファイルを読みます`, '設定'],
    ['a word at the very end', `${'。'.repeat(3_000)}読み込み`, '読み込み'],
    ['a word that is only a part of a longer word', `${'設定ファイル'.repeat(1_000)}`, 'ファイ'],
  ])('credits exactly what one segmentation of the whole text credits: %s', (_label, text, identifier) => {
    expect(counted(text, identifier).result).toBe(unchunkedHasToken(text, identifier));
  });
});
