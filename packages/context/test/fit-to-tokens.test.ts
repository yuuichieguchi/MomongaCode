import { describe, expect, it } from 'vitest';
import { MIN_ITEM_CAP, fitToTokens } from '@momonga/context';
import { tokensForText } from '@momonga/protocol';

const HANDLE = 'cd'.repeat(32);
const OTHER_HANDLE = 'ef'.repeat(32);

const count = (text: string): number => tokensForText(text);

const fit = (text: string, cap: number, handle: string = HANDLE): Promise<string> => fitToTokens({ text, cap, handle, reader: 'ReadOutput', count });

const markersIn = (text: string): number => text.split('ReadOutput').length - 1;

const longAscii = (): string => Array.from({ length: 3000 }, (_unused, index) => `line ${index + 1} of the build output`).join('\n');

const longJapanese = (): string => 'テスト結果を確認しています。'.repeat(1430).slice(0, 20_000);

describe('fitToTokens, the one cut of a tool output', () => {
  it('returns a text that already fits unchanged and without a marker', async () => {
    const text = 'all 12 tests passed';
    expect(await fit(text, 1500)).toBe(text);
  });

  it('cuts a long text to at most cap meter tokens with one marker naming the handle and ReadOutput', async () => {
    const raw = longAscii();
    const cut = await fit(raw, 1500);
    expect(count(cut)).toBeLessThanOrEqual(1500);
    expect(markersIn(cut)).toBe(1);
    expect(cut).toContain(HANDLE);
  });

  it('keeps a head and a tail of the raw text', async () => {
    const raw = longAscii();
    const cut = await fit(raw, 1500);
    expect(cut.startsWith('line 1 of the build output\n')).toBe(true);
    expect(cut.endsWith('line 3000 of the build output')).toBe(true);
  });

  it('is idempotent: cutting at c1 then at c1 again is the identity', async () => {
    const once = await fit(longAscii(), 1500);
    expect(await fit(once, 1500)).toBe(once);
  });

  it('one marker, never two: cut at c1 then at a smaller c2 yields one marker and at most c2 tokens', async () => {
    const once = await fit(longAscii(), 1500);
    const twice = await fit(once, 600);
    expect(markersIn(twice)).toBe(1);
    expect(count(twice)).toBeLessThanOrEqual(600);
    expect(twice).toContain(HANDLE);
    expect(twice).not.toContain(OTHER_HANDLE);
  });

  it('CJK output: 20 000 Japanese characters cut at itemCap 1 500 hold at most 1 500 meter tokens', async () => {
    const raw = longJapanese();
    expect(raw).toHaveLength(20_000);
    expect(count(raw)).toBe(20_000);
    const cut = await fit(raw, 1500);
    expect(count(cut)).toBeLessThanOrEqual(1500);
    expect(count(cut)).toBeGreaterThan(1500 / 2);
    expect(markersIn(cut)).toBe(1);
  });

  it('the marker alone fits within MIN_ITEM_CAP', async () => {
    const cut = await fit(longAscii(), MIN_ITEM_CAP);
    expect(count(cut)).toBeLessThanOrEqual(MIN_ITEM_CAP);
    expect(markersIn(cut)).toBe(1);
  });

  it('for any output and any cap, the result holds at most cap tokens and at most one marker', async () => {
    const outputs = [longAscii(), longJapanese(), `${longAscii()}\n${longJapanese()}`];
    for (const raw of outputs) {
      for (const cap of [MIN_ITEM_CAP, 100, 777, 1500, 4096]) {
        const cut = await fit(raw, cap);
        expect(count(cut), `cap ${cap}`).toBeLessThanOrEqual(cap);
        expect(markersIn(cut)).toBeLessThanOrEqual(1);
      }
    }
  });
});
