import { describe, expect, it } from 'vitest';
import { MIN_ITEM_CAP, fitToTokens } from '@momonga/context';
import { tokensForText } from '@momonga/protocol';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const HANDLE = 'cd'.repeat(32);

const fit = (text: string, cap: number): Promise<string> => fitToTokens({ text, cap, handle: HANDLE, reader: 'ReadOutput', count: tokensForText });

const inputs: Array<[string, string]> = [
  ['ascii lines', Array.from({ length: 400 }, (_unused, index) => `row ${index}`).join('\n')],
  ['one long ascii line', 'a'.repeat(5000)],
  ['one long emoji line', '😀'.repeat(3000)],
  ['emoji lines', Array.from({ length: 300 }, () => '😀a😀').join('\n')],
  ['only newlines', '\n'.repeat(4000)],
  ['odd surrogate offsets', `b${'😀'.repeat(2500)}`],
];

describe('fitToTokens never splits a surrogate pair and keeps the cap', () => {
  it('keeps the head and the tail of an emoji text whole', async () => {
    const cut = await fit('😀'.repeat(400), 150);
    expect(LONE_SURROGATE.test(cut)).toBe(false);
    expect(cut.startsWith('😀')).toBe(true);
    expect(cut.endsWith('😀')).toBe(true);
  });

  for (const cap of [MIN_ITEM_CAP, MIN_ITEM_CAP + 1, MIN_ITEM_CAP + 2, 157, 257, 401, 1000]) {
    it.each(inputs)(`keeps %s within ${cap} tokens and well formed`, async (_label, text) => {
      const cut = await fit(text, cap);
      expect(tokensForText(cut)).toBeLessThanOrEqual(cap);
      expect(LONE_SURROGATE.test(cut)).toBe(false);
    });
  }
});
