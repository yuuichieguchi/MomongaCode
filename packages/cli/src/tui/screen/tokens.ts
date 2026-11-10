export type TextStyle = { color?: string; bold?: boolean; dimColor?: boolean; inverse?: boolean; underline?: boolean };

export const STYLE_TOKENS = {
  user: { color: 'cyan' },
  dim: { dimColor: true },
  bold: { bold: true },
  error: { color: 'red' },
  warning: { color: 'yellow' },
  notice: { color: 'gray' },
  selection: { inverse: true },
  link: { underline: true },
  'banner.fur': { color: '#a9744f' },
  'banner.membrane': { color: '#7fb2c9' },
  'banner.face': { color: '#f1dfc4' },
  'banner.border': { color: '#a9744f' },
} as const satisfies Record<string, TextStyle>;

export type StyleToken = keyof typeof STYLE_TOKENS;

export const styleOf = (tokens: readonly StyleToken[]): TextStyle => Object.assign({}, ...tokens.map((token) => STYLE_TOKENS[token]));
