import { describe, expect, it } from 'vitest';
import { escapeTerminalBlock, escapeTerminalLine } from '@momonga/protocol';

const hexOf = (codePoint: number): string => `\\u${codePoint.toString(16).padStart(4, '0')}`;

const BIDIRECTIONAL_CONTROLS = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];

const C0_WITHOUT_LAYOUT = Array.from({ length: 0x20 }, (_, codePoint) => codePoint).filter((codePoint) => codePoint !== 0x09 && codePoint !== 0x0a);

const C1 = Array.from({ length: 0x20 }, (_, index) => 0x80 + index);

const labelOf = (codePoint: number): string => `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;

describe('the shared terminal escape', () => {
  it.each([...C0_WITHOUT_LAYOUT, 0x7f, ...C1, ...BIDIRECTIONAL_CONTROLS].map((codePoint) => [labelOf(codePoint), codePoint] as const))(
    'escapes %s as a visible sequence in a block and in a line',
    (_label, codePoint) => {
      const text = `keep${String.fromCodePoint(codePoint)}names`;
      expect(escapeTerminalBlock(text)).toBe(`keep${hexOf(codePoint)}names`);
      expect(escapeTerminalLine(text)).toBe(`keep${hexOf(codePoint)}names`);
    },
  );

  it('keeps newline and tab in a block and escapes them in a line', () => {
    expect(escapeTerminalBlock('one\n\ttwo')).toBe('one\n\ttwo');
    expect(escapeTerminalLine('one\n\ttwo')).toBe('one\\u000a\\u0009two');
  });

  it('keeps ordinary text, non-Latin letters and emoji', () => {
    expect(escapeTerminalBlock('keep names あ مرحبا 🙂')).toBe('keep names あ مرحبا 🙂');
    expect(escapeTerminalLine('keep names あ مرحبا 🙂')).toBe('keep names あ مرحبا 🙂');
  });

  it('turns a CSI introduced by U+009B and an OSC introduced by ESC into plain text', () => {
    expect(escapeTerminalLine('\u009b2J')).toBe('\\u009b2J');
    expect(escapeTerminalLine('\u001b]0;title\u0007')).toBe('\\u001b]0;title\\u0007');
  });
});
