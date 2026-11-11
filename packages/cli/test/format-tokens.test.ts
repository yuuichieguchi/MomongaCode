import { describe, expect, it } from 'vitest';
import { formatTokens } from '../src/format-tokens.ts';
import { footerRow } from '../src/tui/screen/footer.tsx';
import { DEFAULT_KEY_TABLE } from '../src/tui/keys/table.ts';
import { compactedText } from '../src/tui/transcript.ts';

describe('a token count in a row (P-277)', () => {
  it('is written whole below a thousand, and in thousands with one decimal that a whole number of thousands drops', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(84_000)).toBe('84k');
    expect(formatTokens(84_049)).toBe('84k');
    expect(formatTokens(84_060)).toBe('84.1k');
    expect(formatTokens(200_000)).toBe('200k');
  });

  it('is the same text in the compaction row and in the footer', () => {
    expect(compactedText(84_000, 12_000)).toBe('Compacted: 84k -> 12k tokens');
    expect(compactedText(84_000, 12_345)).toBe('Compacted: 84k -> 12.3k tokens');
    const facts = { mode: 'manual', tokens: 84_000, contextPercent: 42, imageInput: false, answer: undefined, newline: undefined };
    expect(footerRow(facts, 80, DEFAULT_KEY_TABLE)).toBe('mode: manual (shift+tab) · tokens: 84k · context: 42%');
  });
});
