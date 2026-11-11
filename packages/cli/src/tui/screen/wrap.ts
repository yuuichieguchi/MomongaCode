import { escapeTerminalBlock } from '@momonga/protocol';
import { TAB_COLUMNS } from './constants.ts';
import type { StyleToken } from './tokens.ts';

export type Span = readonly [start: number, end: number, token: StyleToken];

export type Link = readonly [start: number, end: number, url: string];

export type Row = { text: string; spans: readonly Span[]; wrapped: boolean; prefixCols: number; links?: readonly Link[] };

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const ZERO_WIDTH = /^[\p{Mark}\p{Default_Ignorable_Code_Point}\p{Control}]+$/u;
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{20000}-\u{3FFFD}]|\p{Emoji_Presentation}|️/u;

export const graphemeWidth = (segment: string): number => {
  if (ZERO_WIDTH.test(segment)) return 0;
  return WIDE.test(segment) ? 2 : 1;
};

export const segmentsOf = (text: string): { segment: string; index: number; width: number }[] => Array.from(graphemes.segment(text), ({ segment, index }) => ({ segment, index, width: graphemeWidth(segment) }));

export const displayWidth = (text: string): number => {
  let width = 0;
  for (const { segment } of graphemes.segment(text)) width += graphemeWidth(segment);
  return width;
};

export const withoutTabs = (text: string): string => text.replaceAll('\t', ' '.repeat(TAB_COLUMNS));

export const inertText = (text: string): string => withoutTabs(escapeTerminalBlock(text.replaceAll('\r\n', '\n')));

const BARE_URL = /https?:\/\/[^\s<>"'`\\]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

const WEB_PROTOCOLS: readonly string[] = ['http:', 'https:'];

export const parseWebUrl = (text: string): URL | undefined => {
  const url = URL.parse(text);
  return url !== null && WEB_PROTOCOLS.includes(url.protocol) ? url : undefined;
};

export const linksOf = (text: string): Link[] =>
  Array.from(text.matchAll(BARE_URL), (match): Link => {
    const url = match[0].replace(TRAILING_PUNCTUATION, '');
    return [match.index, match.index + url.length, url];
  }).filter(([, , url]) => parseWebUrl(url) !== undefined);

export type WrapOptions = { first?: string; rest?: string; token?: StyleToken; links?: boolean };

const pieceOf = (line: string, from: number, to: number, prefix: string, wrapped: boolean, token: StyleToken | undefined, links: readonly Link[]): Row => {
  const text = `${prefix}${line.slice(from, to)}`;
  const shift = prefix.length - from;
  const within = links.filter(([start, end]) => start < to && end > from).map(([start, end, url]): Link => [Math.max(start, from) + shift, Math.min(end, to) + shift, url]);
  return {
    text,
    spans: token === undefined ? [] : [[0, text.length, token]],
    wrapped,
    prefixCols: displayWidth(prefix),
    ...(within.length === 0 ? {} : { links: within }),
  };
};

export const wrapLine = (line: string, width: number, options: WrapOptions = {}): Row[] => {
  const first = options.first ?? '';
  const rest = options.rest ?? '';
  const links = options.links === false ? [] : linksOf(line);
  const rows: Row[] = [];
  let rowStart = 0;
  let used = displayWidth(first);
  let breakAt: number | undefined;
  let usedAtBreak = 0;
  const emit = (to: number): void => {
    rows.push(pieceOf(line, rowStart, to, rows.length === 0 ? first : rest, rows.length > 0, options.token, links));
    rowStart = to;
  };
  for (const { segment, index, width: cells } of segmentsOf(line)) {
    if (used + cells > width && breakAt !== undefined && breakAt > rowStart) {
      emit(breakAt);
      used = displayWidth(rest) + (used - usedAtBreak);
      breakAt = undefined;
    }
    if (used + cells > width && index > rowStart) {
      emit(index);
      used = displayWidth(rest);
      breakAt = undefined;
    }
    used += cells;
    if (segment === ' ') {
      breakAt = index + segment.length;
      usedAtBreak = used;
    }
  }
  emit(line.length);
  return rows;
};

export const wrapText = (text: string, width: number, options: WrapOptions = {}): Row[] =>
  text.split('\n').flatMap((line, index) => wrapLine(line, width, index === 0 ? options : { ...options, first: options.rest ?? '' }));

const textOf = (row: Row): string => {
  let cells = 0;
  for (const { index, width } of segmentsOf(row.text)) {
    if (cells >= row.prefixCols) return row.text.slice(index);
    cells += width;
  }
  return '';
};

export const logicalText = (rows: readonly Row[]): string => rows.map((row, index) => `${index === 0 || row.wrapped ? '' : '\n'}${textOf(row)}`).join('');
