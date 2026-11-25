import path from 'node:path';
import { displayWidth, wrapLine } from './screen/wrap.ts';
import type { Row, Span } from './screen/wrap.ts';
import type { StyleToken } from './screen/tokens.ts';
import { ART_WIDTH, FIGURE } from './figure.ts';
import type { ArtPart } from './figure.ts';
import { effortLine } from './effort.ts';
import type { ShownEffort } from './effort.ts';

export type StartupConfig = { version: string; home: string };

export type BannerModel = { kind: 'connected'; name: string; effort?: ShownEffort; reading?: boolean } | { kind: 'not-connected'; login: boolean } | { kind: 'unread' };

export type StartupBanner = { config: StartupConfig; model: BannerModel; cwd: string; notices: readonly string[]; figure: boolean };

export const ART_GAP = 2;

const BOX_CHROME_COLUMNS = 4;

export const shortenHome = (cwd: string, home: string): string => {
  if (cwd === home) return '~';
  return cwd.startsWith(`${home}${path.sep}`) ? `~${cwd.slice(home.length)}` : cwd;
};

export const NOT_CONNECTED_MODEL = 'not connected';

export const LOGIN_POINTER = '  (use /login)';

const modelLines = (model: BannerModel): [model: string, effort: string] => {
  switch (model.kind) {
    case 'unread':
      return ['', ''];
    case 'not-connected':
      return [`model: ${model.login ? `${NOT_CONNECTED_MODEL}${LOGIN_POINTER}` : NOT_CONNECTED_MODEL}`, ''];
    case 'connected':
      return [`model: ${model.name}`, model.effort === undefined ? '' : effortLine(model.effort, 'full')];
  }
};

export const textLines = (config: StartupConfig, model: BannerModel, cwd: string): string[] => [`MomongaCode v${config.version}`, ...modelLines(model), shortenHome(cwd, config.home)];

export const artFits = (columns: number, lines: readonly string[]): boolean =>
  columns >= ART_WIDTH + ART_GAP + Math.max(...lines.map((line) => [...line].length)) + BOX_CHROME_COLUMNS;

type Cell = { text: string; token?: StyleToken };

const lineToken = (index: number, count: number): StyleToken | undefined => (index === 0 ? 'bold' : index === count - 1 ? 'dim' : undefined);

const padded = (cells: readonly Cell[], width: number): Cell[] => {
  const used = cells.reduce((total, cell) => total + displayWidth(cell.text), 0);
  return [...cells, { text: ' '.repeat(Math.max(0, width - used)) }];
};

const rowOf = (cells: readonly Cell[]): Row => {
  const spans: Span[] = [];
  let text = '';
  for (const cell of cells) {
    if (cell.token !== undefined && cell.text !== '') spans.push([text.length, text.length + cell.text.length, cell.token]);
    text += cell.text;
  }
  return { text, spans, wrapped: false, prefixCols: 0 };
};

export const figureDrawn = (banner: StartupBanner, columns: number): boolean => banner.figure && artFits(columns, textLines(banner.config, banner.model, banner.cwd));

export const bannerRows = (banner: StartupBanner, columns: number): Row[] => {
  const { config, model, cwd, notices } = banner;
  const inner = Math.max(1, columns - BOX_CHROME_COLUMNS);
  const lines = textLines(config, model, cwd);
  const art = figureDrawn(banner, columns) ? FIGURE : [];
  const textWidth = art.length === 0 ? inner : inner - ART_WIDTH - ART_GAP;
  const text: Cell[][] = lines.flatMap((line, index) => wrapLine(line, textWidth, { links: false }).map((row): Cell[] => {
    const token = lineToken(index, lines.length);
    return [{ text: row.text, ...(token === undefined ? {} : { token }) }];
  }));
  const noticeCells: Cell[][] = notices.flatMap((notice) => wrapLine(`! ${notice}`, textWidth, { links: false }).map((row): Cell[] => [{ text: row.text, token: 'warning' }]));
  const rightColumn: Cell[][] = [...text, ...noticeCells];
  const bodyCells = (index: number, figurePart: readonly ArtPart[] | undefined): Cell[] => [
    ...(art.length === 0 ? [] : [...padded(figurePart ?? [], ART_WIDTH), { text: ' '.repeat(ART_GAP) }]),
    ...(rightColumn[index] ?? []),
  ];
  const edge = (text: string): Cell => ({ text, token: 'banner.border' });
  const framed = (cells: readonly Cell[]): Row => rowOf([edge('│'), { text: ' ' }, ...padded(cells, inner), { text: ' ' }, edge('│')]);
  const bodyRows = Array.from({ length: Math.max(art.length, rightColumn.length) }, (_, index): Row => {
    const swing = art[index]?.swing;
    const rest = framed(bodyCells(index, art[index]?.rest));
    return swing === undefined ? rest : { ...rest, swing: framed(bodyCells(index, swing)) };
  });
  return [rowOf([edge(`╭${'─'.repeat(inner + 2)}╮`)]), ...bodyRows, rowOf([edge(`╰${'─'.repeat(inner + 2)}╯`)])];
};
