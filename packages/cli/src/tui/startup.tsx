import path from 'node:path';
import { displayWidth, wrapLine } from './screen/wrap.ts';
import type { Row, Span } from './screen/wrap.ts';
import type { StyleToken } from './screen/tokens.ts';

export type StartupConfig = { version: string; home: string; color: boolean };

export type StartupModel = { alias: string; targets: readonly string[] | undefined };

export type StartupBanner = { config: StartupConfig; model: StartupModel; mode: string; cwd: string; notices: readonly string[] };

type ArtPart = { text: string; token?: StyleToken };

const ART: readonly (readonly ArtPart[])[] = [
  [{ text: '      ' }, { text: '∩   ∩', token: 'banner.fur' }],
  [{ text: '  ' }, { text: '╭───', token: 'banner.membrane' }, { text: '(', token: 'banner.fur' }, { text: '•ᴥ•', token: 'banner.face' }, { text: ')', token: 'banner.fur' }, { text: '───╮', token: 'banner.membrane' }],
  [{ text: ' ' }, { text: '╭╯░░░░░░░░░░░╰╮', token: 'banner.membrane' }],
  [{ text: ' ' }, { text: '╰╮░░░░░░░░░░░╭╯', token: 'banner.membrane' }],
  [{ text: '  ' }, { text: '╰─╯ ╰─', token: 'banner.membrane' }, { text: '┬', token: 'banner.fur' }, { text: '─╯ ╰─╯', token: 'banner.membrane' }],
  [{ text: '        ' }, { text: '╰╮', token: 'banner.fur' }],
];

const lengthOfRow = (row: readonly { text: string }[]): number => row.reduce((total, part) => total + [...part.text].length, 0);

export const ART_WIDTH = Math.max(...ART.map(lengthOfRow));

export const ART_GAP = 2;

const BOX_CHROME_COLUMNS = 4;

export const shortenHome = (cwd: string, home: string): string => {
  if (cwd === home) return '~';
  return cwd.startsWith(`${home}${path.sep}`) ? `~${cwd.slice(home.length)}` : cwd;
};

export const textLines = (config: StartupConfig, model: StartupModel, mode: string, cwd: string): string[] => [
  `MomongaCode v${config.version}`,
  `model: ${model.alias}${model.targets === undefined ? '' : ` → ${model.targets.join(', ')}`}`,
  `mode: ${mode}`,
  shortenHome(cwd, config.home),
];

export const artFits = (columns: number, lines: readonly string[]): boolean =>
  columns >= ART_WIDTH + ART_GAP + Math.max(...lines.map((line) => [...line].length)) + BOX_CHROME_COLUMNS;

type Cell = { text: string; token?: StyleToken };

const LINE_TOKENS: readonly (StyleToken | undefined)[] = ['bold', undefined, undefined, 'dim'];

const padded = (cells: readonly Cell[], width: number): Cell[] => {
  const used = cells.reduce((total, cell) => total + displayWidth(cell.text), 0);
  return [...cells, { text: ' '.repeat(Math.max(0, width - used)) }];
};

const rowOf = (cells: readonly Cell[], color: boolean): Row => {
  const spans: Span[] = [];
  let text = '';
  for (const cell of cells) {
    if (cell.token !== undefined && cell.text !== '' && (color || cell.token === 'bold' || cell.token === 'dim')) spans.push([text.length, text.length + cell.text.length, cell.token]);
    text += cell.text;
  }
  return { text, spans, wrapped: false, prefixCols: 0 };
};

export const bannerRows = (banner: StartupBanner, columns: number): Row[] => {
  const { config, model, mode, cwd, notices } = banner;
  const inner = Math.max(1, columns - BOX_CHROME_COLUMNS);
  const lines = textLines(config, model, mode, cwd);
  const art = artFits(columns, lines) ? ART : [];
  const textWidth = art.length === 0 ? inner : inner - ART_WIDTH - ART_GAP;
  const text: Cell[][] = lines.flatMap((line, index) => wrapLine(line, textWidth, { links: false }).map((row): Cell[] => [{ text: row.text, ...(LINE_TOKENS[index] === undefined ? {} : { token: LINE_TOKENS[index] }) }]));
  const body: Cell[][] = Array.from({ length: Math.max(art.length, text.length) }, (_, index) => [
    ...(art.length === 0 ? [] : [...padded(art[index] ?? [], ART_WIDTH), { text: ' '.repeat(ART_GAP) }]),
    ...(text[index] ?? []),
  ]);
  const noticeRows: Cell[][] = notices.length === 0 ? [] : [[], ...notices.flatMap((notice) => wrapLine(`! ${notice}`, inner, { links: false }).map((row): Cell[] => [{ text: row.text, token: 'warning' }]))];
  const edge = (text: string): Cell => ({ text, token: 'banner.border' });
  return [
    rowOf([edge(`╭${'─'.repeat(inner + 2)}╮`)], config.color),
    ...[...body, ...noticeRows].map((cells) => rowOf([edge('│'), { text: ' ' }, ...padded(cells, inner), { text: ' ' }, edge('│')], config.color)),
    rowOf([edge(`╰${'─'.repeat(inner + 2)}╯`)], config.color),
  ];
};
