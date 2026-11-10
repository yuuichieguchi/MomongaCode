export type TextStyle = { color?: string; bold?: boolean; dimColor?: boolean; inverse?: boolean; underline?: boolean };

export type Paint = { truecolor: string; ansi256: number };

export type Attrs = { bold?: true; dim?: true; underline?: true; inverse?: true };

export type TokenStyle = { dark?: Paint; light?: Paint; ansi16?: string; attrs: Attrs };

const NONE: Attrs = {};

const USER: TokenStyle = { dark: { truecolor: '#56b6c2', ansi256: 73 }, light: { truecolor: '#0b6b78', ansi256: 24 }, ansi16: 'cyan', attrs: NONE };
const ACCENT: TokenStyle = { dark: { truecolor: '#7fb2c9', ansi256: 110 }, light: { truecolor: '#1d5f8a', ansi256: 24 }, ansi16: 'cyan', attrs: NONE };
const ERROR: TokenStyle = { dark: { truecolor: '#f47067', ansi256: 203 }, light: { truecolor: '#b3261e', ansi256: 124 }, ansi16: 'red', attrs: NONE };
const WARNING: TokenStyle = { dark: { truecolor: '#e0af68', ansi256: 179 }, light: { truecolor: '#7a4f00', ansi256: 94 }, ansi16: 'yellow', attrs: NONE };
const SUCCESS: TokenStyle = { dark: { truecolor: '#7ec97e', ansi256: 114 }, light: { truecolor: '#1a6b2f', ansi256: 22 }, ansi16: 'green', attrs: NONE };
const MUTED: TokenStyle = { dark: { truecolor: '#8b949e', ansi256: 246 }, light: { truecolor: '#57606a', ansi256: 241 }, ansi16: 'gray', attrs: NONE };
const FUR: TokenStyle = { dark: { truecolor: '#b9855f', ansi256: 137 }, light: { truecolor: '#8a5a38', ansi256: 94 }, ansi16: 'yellow', attrs: NONE };
const MEMBRANE: TokenStyle = { dark: { truecolor: '#7fb2c9', ansi256: 110 }, light: { truecolor: '#2f6f8c', ansi256: 24 }, ansi16: 'cyan', attrs: NONE };
const FACE: TokenStyle = { dark: { truecolor: '#f1dfc4', ansi256: 223 }, light: { truecolor: '#6e5330', ansi256: 58 }, attrs: NONE };

export const STYLE = {
  text: { attrs: NONE },
  dim: { attrs: { dim: true } },
  bold: { attrs: { bold: true } },
  user: USER,
  accent: ACCENT,
  error: ERROR,
  warning: WARNING,
  success: SUCCESS,
  notice: MUTED,
  'diff.added': SUCCESS,
  'diff.removed': ERROR,
  code: { dark: { truecolor: '#d2a8ff', ansi256: 183 }, light: { truecolor: '#6f42c1', ansi256: 55 }, ansi16: 'magenta', attrs: NONE },
  link: { attrs: { underline: true } },
  'choice.selected': { ...ACCENT, attrs: { bold: true } },
  selection: { attrs: { inverse: true } },
  border: MUTED,
  'art.fur': FUR,
  'art.membrane': MEMBRANE,
  'art.face': FACE,
  'banner.fur': FUR,
  'banner.membrane': MEMBRANE,
  'banner.face': FACE,
  'banner.border': FUR,
} as const satisfies Record<string, TokenStyle>;

export type StyleToken = keyof typeof STYLE;

export const STYLE_TOKEN_NAMES = Object.keys(STYLE) as StyleToken[];

export type Background = 'dark' | 'light' | 'unknown';

export const COLOR_LEVELS = [0, 1, 2, 3] as const;

export type ColorLevel = (typeof COLOR_LEVELS)[number];

export type ColourHost = { noColor: boolean; level: ColorLevel };

export type Appearance = ColourHost & { background: Background };

export const UNREPORTED_COLOUR_HOST: ColourHost = { noColor: false, level: 1 };

export const noColorAsked = (env: Readonly<Record<string, string | undefined>>): boolean => {
  const value = env['NO_COLOR'];
  return value !== undefined && value !== '';
};

const COLOR_DEPTH_LEVELS: ReadonlyMap<number, ColorLevel> = new Map([
  [1, 0],
  [4, 1],
  [8, 2],
  [24, 3],
]);

export const colorLevelOfDepth = (bits: number): ColorLevel => {
  const level = COLOR_DEPTH_LEVELS.get(bits);
  if (level === undefined) throw new Error(`the terminal reports a colour depth of ${bits} bits, which is not one of 1, 4, 8, 24`);
  return level;
};

const BACKGROUND_REPLY = /^rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?$/i;

const LUMA_RED = 0.299;
const LUMA_GREEN = 0.587;
const LUMA_BLUE = 0.114;
const LIGHT_ABOVE_LUMA = 0.5;

const channelOf = (digits: string): number => Number.parseInt(digits, 16) / (16 ** digits.length - 1);

export const lumaOfReply = (reply: string): number | undefined => {
  const match = BACKGROUND_REPLY.exec(reply);
  if (match === null) return undefined;
  const [, red = '', green = '', blue = ''] = match;
  return LUMA_RED * channelOf(red) + LUMA_GREEN * channelOf(green) + LUMA_BLUE * channelOf(blue);
};

export const backgroundOf = (reply: string | undefined): Background => {
  const luma = reply === undefined ? undefined : lumaOfReply(reply);
  if (luma === undefined) return 'unknown';
  return luma > LIGHT_ABOVE_LUMA ? 'light' : 'dark';
};

export const appearanceOf = (host: ColourHost, backgroundReply: string | undefined): Appearance => ({ ...host, background: backgroundOf(backgroundReply) });

const ANSI16_LEVEL = 1;
const ANSI256_LEVEL = 2;

const colorOf = (style: TokenStyle, appearance: Appearance): string | undefined => {
  if (appearance.noColor || appearance.level < ANSI16_LEVEL) return undefined;
  if (appearance.background === 'unknown' || appearance.level === ANSI16_LEVEL) return style.ansi16;
  const paint = style[appearance.background];
  if (paint === undefined) return undefined;
  return appearance.level === ANSI256_LEVEL ? `ansi256(${paint.ansi256})` : paint.truecolor;
};

export const styleOfToken = (token: StyleToken, appearance: Appearance): TextStyle => {
  const style: TokenStyle = STYLE[token];
  const color = colorOf(style, appearance);
  return {
    ...(color === undefined ? {} : { color }),
    ...(style.attrs.bold === true ? { bold: true } : {}),
    ...(style.attrs.dim === true ? { dimColor: true } : {}),
    ...(style.attrs.inverse === true ? { inverse: true } : {}),
    ...(style.attrs.underline === true ? { underline: true } : {}),
  };
};

let current: Appearance = appearanceOf(UNREPORTED_COLOUR_HOST, undefined);

export const applyAppearance = (next: Appearance): void => {
  current = next;
};

export const currentAppearance = (): Appearance => current;

export const styleOf = (tokens: readonly StyleToken[], appearance: Appearance = current): TextStyle => Object.assign({}, ...tokens.map((token) => styleOfToken(token, appearance)));

export const borderOf = (token: StyleToken, appearance: Appearance = current): { borderColor?: string } => {
  const { color } = styleOfToken(token, appearance);
  return color === undefined ? {} : { borderColor: color };
};
