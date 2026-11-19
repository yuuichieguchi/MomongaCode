import { TAIL_WAG_FRAMES, TAIL_WAG_MS } from '../../packages/cli/src/tui/figure.ts';
import { STYLE } from '../../packages/cli/src/tui/screen/theme.ts';
import type { Attrs, TokenStyle } from '../../packages/cli/src/tui/screen/theme.ts';
import { FIGURE_TEXT_STYLE, ICON_TOKENS } from './figure.ts';
import { tokenClass } from './text.ts';

type Scheme = 'dark' | 'light';

const PAGE_COLOURS: Readonly<Record<Scheme, { background: string; text: string }>> = {
  dark: { background: '#0d1117', text: '#e6edf3' },
  light: { background: '#ffffff', text: '#1f2328' },
};

const TOKENS: readonly [string, TokenStyle][] = Object.entries(STYLE);

const variableOf = (token: string): string => `--${token.replace(/\./g, '-')}`;

const colourOf = (style: TokenStyle, scheme: Scheme): string | undefined => style[scheme]?.truecolor.toLowerCase();

const palette = (scheme: Scheme, only?: ReadonlySet<string>): string =>
  [
    `color-scheme:${scheme}`,
    `--page-background:${PAGE_COLOURS[scheme].background}`,
    `--page-text:${PAGE_COLOURS[scheme].text}`,
    ...TOKENS.flatMap(([token, style]) => {
      const colour = colourOf(style, scheme);
      return colour === undefined || colourOf(style, scheme === 'dark' ? 'light' : 'dark') === undefined || (only !== undefined && !only.has(token)) ? [] : [`${variableOf(token)}:${colour}`];
    }),
  ].join(';');

const ATTR_DECLARATIONS: readonly (readonly [keyof Attrs, string])[] = [
  ['bold', 'font-weight:600'],
  ['dim', 'opacity:0.72'],
  ['italic', 'font-style:italic'],
  ['underline', 'text-decoration:underline'],
  ['inverse', 'color:var(--page-background);background:var(--page-text)'],
];

const tokenRule = ([token, style]: [string, TokenStyle]): string => {
  const declarations = [
    ...(colourOf(style, 'dark') === undefined || colourOf(style, 'light') === undefined ? [] : [`color:var(${variableOf(token)})`, `fill:var(${variableOf(token)})`]),
    ...ATTR_DECLARATIONS.filter(([attr]) => style.attrs[attr] === true).map(([, declaration]) => declaration),
  ];
  return declarations.length === 0 ? '' : `.${tokenClass(token)}{${declarations.join(';')}}`;
};

const percent = (frame: number): string => `${Number(((frame / TAIL_WAG_FRAMES) * 100).toFixed(3))}%`;

const wagKeyframes = (name: string, shownWhenSwung: boolean): string => {
  const frames = Array.from({ length: TAIL_WAG_FRAMES + 1 }, (_, frame) => {
    const swung = frame < TAIL_WAG_FRAMES && frame % 2 === 1;
    return `${percent(frame)}{visibility:${swung === shownWhenSwung ? 'visible' : 'hidden'}}`;
  });
  return `@keyframes ${name}{${frames.join('')}}`;
};

const WAG_MS = TAIL_WAG_FRAMES * TAIL_WAG_MS;

const figureRules = (): string =>
  [
    `.figure text{${FIGURE_TEXT_STYLE}}`,
    '.figure [data-pose="swing"]{visibility:hidden}',
    wagKeyframes('tail-rest', false),
    wagKeyframes('tail-swing', true),
    `.figure [data-pose="rest"]{animation:tail-rest ${WAG_MS}ms step-end 1}`,
    `.figure [data-pose="swing"]{animation:tail-swing ${WAG_MS}ms step-end 1}`,
    '@media (prefers-reduced-motion: reduce){.figure [data-pose]{animation:none}}',
  ].join('\n');

export const themeCss = (): string =>
  [
    `:root,:root[data-theme="light"]{${palette('light')}}`,
    `:root[data-theme="dark"]{${palette('dark')}}`,
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${palette('dark')}}}`,
    ...TOKENS.map(tokenRule).filter((rule) => rule !== ''),
    figureRules(),
  ].join('\n');

export const iconCss = (): string =>
  [
    `svg{${palette('light', ICON_TOKENS)}}`,
    `@media (prefers-color-scheme: dark){svg{${palette('dark', ICON_TOKENS)}}}`,
    `text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;${FIGURE_TEXT_STYLE}}`,
    ...TOKENS.filter(([token]) => ICON_TOKENS.has(token)).map(tokenRule),
  ].join('');
