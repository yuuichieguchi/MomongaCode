import { describe, expect, it } from 'vitest';
import { STYLE, STYLE_TOKEN_NAMES, appearanceOf, backgroundOf, borderOf, colorLevelOfDepth, lumaOfReply, noColorAsked, styleOf, styleOfToken } from '../../src/tui/screen/theme.ts';
import type { Appearance, ColorLevel, Paint, StyleToken, TokenStyle } from '../../src/tui/screen/theme.ts';
import * as tokens from '../../src/tui/screen/tokens.ts';

const DESIGN_TOKENS = ['text', 'dim', 'user', 'accent', 'error', 'warning', 'success', 'diff.added', 'diff.removed', 'code', 'link', 'choice.selected', 'selection', 'border', 'art.fur', 'art.membrane', 'art.face'];
const NAMES_THE_VIEWS_ALREADY_USE = ['bold', 'notice', 'banner.fur', 'banner.membrane', 'banner.face', 'banner.border'];

const table: Readonly<Record<string, TokenStyle>> = STYLE;
const painted = STYLE_TOKEN_NAMES.filter((name) => table[name]?.dark !== undefined);

const on = (background: Appearance['background'], level: ColorLevel, noColor = false): Appearance => ({ background, level, noColor });

const attrsOf = (name: StyleToken) => {
  const { attrs } = table[name] as TokenStyle;
  return {
    ...(attrs.bold === true ? { bold: true } : {}),
    ...(attrs.dim === true ? { dimColor: true } : {}),
    ...(attrs.inverse === true ? { inverse: true } : {}),
    ...(attrs.underline === true ? { underline: true } : {}),
  };
};

const withColor = (name: StyleToken, color: string | undefined) => ({ ...(color === undefined ? {} : { color }), ...attrsOf(name) });

const linear = (channel: number): number => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);

const luminance = (hex: string): number => {
  const value = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * linear(((value >> 16) & 255) / 255) + 0.7152 * linear(((value >> 8) & 255) / 255) + 0.0722 * linear((value & 255) / 255);
};

const contrast = (one: string, other: string): number => {
  const [lighter, darker] = [luminance(one), luminance(other)].sort((a, b) => b - a) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
};

const DARK_REFERENCE = '#1e1e1e';
const LIGHT_REFERENCE = '#ffffff';
const READABLE_CONTRAST = 4.5;

describe('the style token table', () => {
  it('holds every token of the design and every name the views already use', () => {
    expect([...STYLE_TOKEN_NAMES].sort()).toEqual([...DESIGN_TOKENS, ...NAMES_THE_VIEWS_ALREADY_USE].sort());
  });

  it('keeps the attributes that carry meaning without colour', () => {
    expect(STYLE.dim.attrs).toEqual({ dim: true });
    expect(STYLE.bold.attrs).toEqual({ bold: true });
    expect(STYLE.link.attrs).toEqual({ underline: true });
    expect(STYLE.selection.attrs).toEqual({ inverse: true });
    expect(STYLE['choice.selected'].attrs).toEqual({ bold: true });
  });

  it('gives a painted token a value for a dark and for a light background', () => {
    for (const name of painted) {
      const style = table[name] as TokenStyle;
      for (const paint of [style.dark, style.light] as Paint[]) {
        expect(paint.truecolor).toMatch(/^#[0-9a-f]{6}$/);
        expect(Number.isInteger(paint.ansi256) && paint.ansi256 >= 16 && paint.ansi256 <= 255).toBe(true);
      }
    }
  });

  it('is readable: every truecolor value has a contrast of 4.5 to 1 against its background', () => {
    for (const name of painted) {
      const style = table[name] as TokenStyle;
      expect(contrast((style.dark as Paint).truecolor, DARK_REFERENCE), `${name} on dark`).toBeGreaterThanOrEqual(READABLE_CONTRAST);
      expect(contrast((style.light as Paint).truecolor, LIGHT_REFERENCE), `${name} on light`).toBeGreaterThanOrEqual(READABLE_CONTRAST);
    }
  });

  it('is exported under the names the views import from tokens.ts', () => {
    expect(tokens.STYLE_TOKENS).toBe(STYLE);
    expect(tokens.styleOf).toBe(styleOf);
  });
});

describe('the style of a token', () => {
  it.each(STYLE_TOKEN_NAMES)('%s on a dark background', (name) => {
    const style = table[name] as TokenStyle;
    expect(styleOfToken(name, on('dark', 3))).toEqual(withColor(name, style.dark?.truecolor));
    expect(styleOfToken(name, on('dark', 2))).toEqual(withColor(name, style.dark === undefined ? undefined : `ansi256(${style.dark.ansi256})`));
    expect(styleOfToken(name, on('dark', 1))).toEqual(withColor(name, style.ansi16));
    expect(styleOfToken(name, on('dark', 0))).toEqual(attrsOf(name));
  });

  it.each(STYLE_TOKEN_NAMES)('%s on a light background', (name) => {
    const style = table[name] as TokenStyle;
    expect(styleOfToken(name, on('light', 3))).toEqual(withColor(name, style.light?.truecolor));
    expect(styleOfToken(name, on('light', 2))).toEqual(withColor(name, style.light === undefined ? undefined : `ansi256(${style.light.ansi256})`));
    expect(styleOfToken(name, on('light', 1))).toEqual(withColor(name, style.ansi16));
    expect(styleOfToken(name, on('light', 0))).toEqual(attrsOf(name));
  });

  it.each(STYLE_TOKEN_NAMES)('%s on an unknown background uses the terminal palette at every level', (name) => {
    const style = table[name] as TokenStyle;
    for (const level of [1, 2, 3] as const) expect(styleOfToken(name, on('unknown', level))).toEqual(withColor(name, style.ansi16));
    expect(styleOfToken(name, on('unknown', 0))).toEqual(attrsOf(name));
  });

  it.each(STYLE_TOKEN_NAMES)('%s under NO_COLOR has its attributes and no colour', (name) => {
    for (const background of ['dark', 'light', 'unknown'] as const) for (const level of [0, 1, 2, 3] as const) expect(styleOfToken(name, on(background, level, true))).toEqual(attrsOf(name));
  });

  it('names concrete values', () => {
    expect(styleOfToken('user', on('dark', 3))).toEqual({ color: '#56b6c2' });
    expect(styleOfToken('user', on('light', 3))).toEqual({ color: '#0b6b78' });
    expect(styleOfToken('user', on('unknown', 3))).toEqual({ color: 'cyan' });
    expect(styleOfToken('choice.selected', on('dark', 3, true))).toEqual({ bold: true });
    expect(styleOfToken('text', on('dark', 3))).toEqual({});
  });

  it('merges the tokens of a piece, a later one over an earlier one', () => {
    expect(styleOf(['error', 'selection'], on('dark', 3))).toEqual({ color: '#f47067', inverse: true });
    expect(styleOf(['error', 'warning'], on('unknown', 1))).toEqual({ color: 'yellow' });
    expect(styleOf([], on('dark', 3))).toEqual({});
  });

  it('gives a border its colour, or none', () => {
    expect(borderOf('border', on('light', 3))).toEqual({ borderColor: '#57606a' });
    expect(borderOf('border', on('light', 3, true))).toEqual({});
  });
});

describe('the background the terminal reports', () => {
  it.each([
    ['rgb:0000/0000/0000', 'dark'],
    ['rgb:ffff/ffff/ffff', 'light'],
    ['rgb:1e1e/1e1e/1e1e', 'dark'],
    ['rgb:fd/f6/e3', 'light'],
    ['rgb:f/f/f', 'light'],
    ['rgb:000/000/000', 'dark'],
    ['rgba:ffff/ffff/ffff/8000', 'light'],
    ['rgb:FFFF/0000/0000', 'dark'],
    ['rgb:0000/ffff/0000', 'light'],
  ] as const)('%s is %s', (reply, background) => {
    expect(backgroundOf(reply)).toBe(background);
  });

  it('is unknown without an answer and for an answer of no known form', () => {
    expect(backgroundOf(undefined)).toBe('unknown');
    for (const reply of ['', '#ffffff', 'rgb:ffff/ffff', 'rgb:gggg/0000/0000', 'rgb:fffff/0/0', 'white']) expect(backgroundOf(reply)).toBe('unknown');
  });

  it('weighs the channels by Rec. 601', () => {
    expect(lumaOfReply('rgb:ffff/0000/0000')).toBeCloseTo(0.299, 10);
    expect(lumaOfReply('rgb:0000/ffff/0000')).toBeCloseTo(0.587, 10);
    expect(lumaOfReply('rgb:0000/0000/ffff')).toBeCloseTo(0.114, 10);
    expect(backgroundOf('rgb:8080/8080/8080')).toBe('light');
    expect(backgroundOf('rgb:7f7f/7f7f/7f7f')).toBe('dark');
  });

  it('joins what the host reports with the answer', () => {
    expect(appearanceOf({ noColor: true, level: 2 }, 'rgb:ffff/ffff/ffff')).toEqual({ noColor: true, level: 2, background: 'light' });
  });
});

describe('what the host reports', () => {
  it('reads NO_COLOR as asked only when it is set and not empty', () => {
    expect(noColorAsked({})).toBe(false);
    expect(noColorAsked({ NO_COLOR: '' })).toBe(false);
    expect(noColorAsked({ NO_COLOR: '1' })).toBe(true);
    expect(noColorAsked({ NO_COLOR: '0' })).toBe(true);
  });

  it('takes the colour level from the colour depth', () => {
    expect([1, 4, 8, 24].map(colorLevelOfDepth)).toEqual([0, 1, 2, 3]);
    expect(() => colorLevelOfDepth(16)).toThrow('16 bits');
  });
});
