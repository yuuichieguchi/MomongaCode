import type { StyleToken } from './tokens.ts';
import { displayWidth, inertText, parseWebUrl, wrapLine } from './wrap.ts';
import type { Link, Row, Span } from './wrap.ts';

export const MARKDOWN_UNIT_BYTES = 16 * 1024;

const INLINE_NESTING_MAX = 8;
const WIDEST_GRAPHEME_COLUMNS = 2;
const CODE_INDENT = '  ';
const CODE_BLOCK_INDENT = 4;
const QUOTE_GUTTER = '│ ';
const BULLET = '•';

const MARKDOWN_STYLE = {
  heading: 'bold',
  strong: 'bold',
  emphasis: 'bold',
  code: 'code',
  language: 'dim',
  gutter: 'dim',
  rule: 'dim',
  border: 'dim',
  tableHeader: 'bold',
} as const satisfies Record<string, StyleToken>;

type Role = keyof typeof MARKDOWN_STYLE;

type Inline = { text: string; spans: Span[]; links: Link[] };

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const HEADING = /^ {0,3}#{1,6} +/;
const UNDERLINE = /^ {0,3}(?:=+|-+) *$/;
const RULE = /^ {0,3}([-*_])(?: *\1){2,} *$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)]) +(.*)$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const CELL_BAR = /(?<!\\)\|/;

const PLAIN = /[^\\`[<*_h]+/y;
const ESCAPED_MARK = /\\([!-/:-@[-`{-~])/y;
const MARKDOWN_LINK = /\[((?:\\.|[^[\]\\])*)\]\(\s*<?([^\s()<>]+)>?(?:\s+"[^"]*")?\s*\)/y;
const AUTOLINK = /<(https?:\/\/[^\s<>]+)>/y;
const BARE_URL = /https?:\/\/[^\s<>"'`\\]+/y;
const URL_TRAILING = /[.,;:!?)\]}*_~]+$/;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

const emptyInline = (): Inline => ({ text: '', spans: [], links: [] });

const styled = (out: Inline, role: Role, write: () => void): void => {
  const start = out.text.length;
  write();
  if (out.text.length > start) out.spans.push([start, out.text.length, MARKDOWN_STYLE[role]]);
};

const linked = (out: Inline, url: string, write: () => void): void => {
  const start = out.text.length;
  write();
  if (parseWebUrl(url) !== undefined && out.text.length > start) out.links.push([start, out.text.length, url]);
};

const runLength = (source: string, position: number): number => {
  let end = position;
  while (source[end] === source[position]) end += 1;
  return end - position;
};

const closerOf = (source: string, mark: string, from: number, accepts: (index: number) => boolean): number | undefined => {
  for (let index = source.indexOf(mark, from); index >= 0; index = source.indexOf(mark, index + 1)) {
    const exact = source[index - 1] !== mark[0] && source[index + mark.length] !== mark[0];
    if (exact && accepts(index)) return index;
  }
  return undefined;
};

type CodeMarks = (length: number, from: number) => number | undefined;

const codeMarksOf = (source: string): CodeMarks => {
  let runs: Map<number, { starts: number[]; next: number }> | undefined;
  const read = (): Map<number, { starts: number[]; next: number }> => {
    const found = new Map<number, { starts: number[]; next: number }>();
    for (let index = source.indexOf('`'); index >= 0; ) {
      const length = runLength(source, index);
      const held = found.get(length);
      if (held === undefined) found.set(length, { starts: [index], next: 0 });
      else held.starts.push(index);
      index = source.indexOf('`', index + length);
    }
    return found;
  };
  return (length, from) => {
    runs ??= read();
    const held = runs.get(length);
    if (held === undefined) return undefined;
    while ((held.starts[held.next] ?? from) < from) held.next += 1;
    return held.starts[held.next];
  };
};

const inlineInto = (out: Inline, source: string, depth: number): void => {
  const unclosed = new Set<string>();
  const codeMark = codeMarksOf(source);
  const sticky = (pattern: RegExp, position: number): RegExpExecArray | null => {
    pattern.lastIndex = position;
    return pattern.exec(source);
  };
  const closer = (mark: string, from: number, accepts: (index: number) => boolean): number | undefined => {
    if (unclosed.has(mark)) return undefined;
    const found = closerOf(source, mark, from, accepts);
    if (found === undefined) unclosed.add(mark);
    return found;
  };

  const escapeAt = (position: number): number | undefined => {
    const match = sticky(ESCAPED_MARK, position);
    if (match === null) return undefined;
    out.text += match[1];
    return ESCAPED_MARK.lastIndex;
  };

  const codeAt = (position: number): number | undefined => {
    const length = runLength(source, position);
    const end = codeMark(length, position + length);
    if (end === undefined) {
      out.text += source.slice(position, position + length);
      return position + length;
    }
    const inner = source.slice(position + length, end);
    const padded = inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '';
    styled(out, 'code', () => {
      out.text += padded ? inner.slice(1, -1) : inner;
    });
    return end + length;
  };

  const linkAt = (position: number): number | undefined => {
    const match = sticky(MARKDOWN_LINK, position);
    const label = match?.[1];
    const url = match?.[2];
    if (label === undefined || url === undefined || depth >= INLINE_NESTING_MAX) return undefined;
    const end = MARKDOWN_LINK.lastIndex;
    const start = out.text.length;
    if (label !== url) linked(out, url, () => inlineInto(out, label, depth + 1));
    const labelled = out.text.length > start;
    if (labelled) out.text += ' (';
    linked(out, url, () => {
      out.text += url;
    });
    if (labelled) out.text += ')';
    return end;
  };

  const autolinkAt = (position: number): number | undefined => {
    const url = sticky(AUTOLINK, position)?.[1];
    if (url === undefined) return undefined;
    const end = AUTOLINK.lastIndex;
    linked(out, url, () => {
      out.text += url;
    });
    return end;
  };

  const bareUrlAt = (position: number): number | undefined => {
    const match = source.startsWith('http', position) ? sticky(BARE_URL, position) : null;
    if (match === null) return undefined;
    const url = match[0].replace(URL_TRAILING, '');
    linked(out, url, () => {
      out.text += url;
    });
    return position + url.length;
  };

  const emphasisAt = (position: number): number | undefined => {
    const mark = source[position];
    const length = runLength(source, position);
    const after = source[position + length];
    const before = source[position - 1];
    const word = (character: string | undefined): boolean => character !== undefined && WORD_CHARACTER.test(character);
    const opens = length <= 3 && depth < INLINE_NESTING_MAX && after !== undefined && !SPACE.test(after) && !(mark === '_' && word(before));
    const end = opens
      ? closer(source.slice(position, position + length), position + length + 1, (index) => {
          const previous = source[index - 1];
          return previous !== undefined && previous !== '\\' && !SPACE.test(previous) && !(mark === '_' && word(source[index + length]));
        })
      : undefined;
    if (end === undefined) return undefined;
    const inner = (): void => inlineInto(out, source.slice(position + length, end), depth + 1);
    if (length === 1) styled(out, 'emphasis', inner);
    else if (length === 2) styled(out, 'strong', inner);
    else styled(out, 'strong', () => styled(out, 'emphasis', inner));
    return end + length;
  };

  const markAt = (position: number): number | undefined => {
    switch (source[position]) {
      case '\\':
        return escapeAt(position);
      case '`':
        return codeAt(position);
      case '[':
        return linkAt(position);
      case '<':
        return autolinkAt(position);
      case 'h':
        return bareUrlAt(position);
      case '*':
      case '_':
        return emphasisAt(position);
      default:
        return undefined;
    }
  };

  let position = 0;
  while (position < source.length) {
    const plain = sticky(PLAIN, position);
    if (plain !== null) {
      out.text += plain[0];
      position = PLAIN.lastIndex;
      continue;
    }
    const next = markAt(position);
    if (next === undefined) {
      const length = source[position] === '*' || source[position] === '_' ? runLength(source, position) : 1;
      out.text += source.slice(position, position + length);
      position += length;
    } else position = next;
  }
};

const inlineOf = (source: string, role?: Role): Inline => {
  const out = emptyInline();
  if (role === undefined) inlineInto(out, source, 0);
  else styled(out, role, () => inlineInto(out, source, 0));
  return out;
};

const joined = (parts: readonly (Inline | string)[]): Inline => {
  const out = emptyInline();
  for (const part of parts) {
    const shift = out.text.length;
    if (typeof part === 'string') out.text += part;
    else {
      out.text += part.text;
      out.spans.push(...part.spans.map(([start, end, token]): Span => [start + shift, end + shift, token]));
      out.links.push(...part.links.map(([start, end, url]): Link => [start + shift, end + shift, url]));
    }
  }
  return out;
};

type Prefix = { first: string; rest: string };

const NO_PREFIX: Prefix = { first: '', rest: '' };

const fits = (prefix: string, width: number): boolean => displayWidth(prefix) + WIDEST_GRAPHEME_COLUMNS <= width;

const wrapInline = (inline: Inline, width: number, prefix: Prefix = NO_PREFIX): Row[] => {
  let from = 0;
  return wrapLine(inline.text, width, { ...prefix, links: false }).map((row, index) => {
    const lead = index === 0 ? prefix.first : prefix.rest;
    const to = from + row.text.length - lead.length;
    const shift = lead.length - from;
    const start = from;
    from = to;
    const spans: Span[] = lead === '' ? [] : [[0, lead.length, MARKDOWN_STYLE.gutter]];
    for (const [spanStart, spanEnd, token] of inline.spans) if (spanStart < to && spanEnd > start) spans.push([Math.max(spanStart, start) + shift, Math.min(spanEnd, to) + shift, token]);
    const links: Link[] = [];
    for (const [linkStart, linkEnd, url] of inline.links) if (linkStart < to && linkEnd > start) links.push([Math.max(linkStart, start) + shift, Math.min(linkEnd, to) + shift, url]);
    return { text: row.text, spans, wrapped: row.wrapped, prefixCols: row.prefixCols, ...(links.length === 0 ? {} : { links }) };
  });
};

const LONGEST_LINE_END = '\r\n';

const sourceBytes = (line: string): number => Buffer.byteLength(line) + LONGEST_LINE_END.length;

const overUnit = (line: string): boolean => sourceBytes(line) > MARKDOWN_UNIT_BYTES;

type Fence = { readonly mark: string; readonly length: number };

const fenceOf = (line: string): (Fence & { info: string }) | undefined => {
  const match = FENCE.exec(line);
  const run = match?.[2];
  const info = match?.[3];
  const mark = run?.[0];
  if (run === undefined || info === undefined || mark === undefined) return undefined;
  return mark === '`' && info.includes('`') ? undefined : { mark, length: run.length, info: info.trim() };
};

const closes = (line: Fence & { info: string }, open: Fence): boolean => line.mark === open.mark && line.length >= open.length && line.info === '';

const withoutClosingMarks = (heading: string): string => {
  const trimmed = heading.trimEnd();
  let end = trimmed.length;
  while (trimmed[end - 1] === '#') end -= 1;
  return end < trimmed.length && (end === 0 || trimmed[end - 1] === ' ') ? trimmed.slice(0, end).trimEnd() : trimmed;
};

const lineRows = (line: string, width: number): Row[] => {
  let gutter = '';
  let content = line;
  for (let quote = QUOTE.exec(content); quote !== null && fits(gutter + QUOTE_GUTTER, width); quote = QUOTE.exec(content)) {
    gutter += QUOTE_GUTTER;
    content = quote[1] ?? '';
  }
  const lead: Prefix = { first: gutter, rest: gutter };
  if (RULE.test(content)) return wrapInline(inlineOf('─'.repeat(Math.max(1, width - displayWidth(gutter))), 'rule'), width, lead);
  const heading = HEADING.exec(content);
  if (heading !== null) return wrapInline(inlineOf(withoutClosingMarks(content.slice(heading[0].length)), 'heading'), width, lead);
  const item = LIST_ITEM.exec(content);
  if (item !== null) {
    const marker = `${item[1] ?? ''}${item[2] === '-' || item[2] === '*' || item[2] === '+' ? BULLET : (item[2] ?? '')} `;
    if (fits(gutter + marker, width)) return wrapInline(inlineOf(item[3] ?? ''), width, { first: gutter + marker, rest: gutter + ' '.repeat(displayWidth(marker)) });
  }
  return wrapInline(inlineOf(content), width, lead);
};

const codeRows = (line: string, width: number, role: Role): Row[] => {
  const prefix: Prefix = fits(CODE_INDENT, width) ? { first: CODE_INDENT, rest: CODE_INDENT } : NO_PREFIX;
  return wrapLine(line, width, { ...prefix, links: false }).map((row) => (row.text.length === prefix.first.length ? row : { ...row, spans: [[prefix.first.length, row.text.length, MARKDOWN_STYLE[role]]] }));
};

const languageRows = (info: string, width: number): Row[] => {
  const [language = ''] = info.split(SPACE);
  return language === '' ? [] : codeRows(language, width, 'language').map((row): Row => ({ ...row, kind: 'label' }));
};

const cellsOf = (line: string): string[] => {
  const trimmed = line.trim();
  const inner = trimmed.slice(trimmed.startsWith('|') ? 1 : 0, trimmed.endsWith('|') && !trimmed.endsWith('\\|') && trimmed.length > 1 ? -1 : undefined);
  return inner.split(CELL_BAR).map((cell) => cell.trim().replaceAll('\\|', '|'));
};

const isTableStart = (header: string, delimiter: string | undefined): delimiter is string =>
  delimiter !== undefined &&
  header.includes('|') &&
  delimiter.includes('-') &&
  sourceBytes(header) + sourceBytes(delimiter) <= MARKDOWN_UNIT_BYTES &&
  TABLE_DELIMITER.test(delimiter) &&
  cellsOf(header).length === cellsOf(delimiter).length;

const isTableRow = (line: string | undefined): line is string => line !== undefined && line.includes('|') && line.trim() !== '' && fenceOf(line) === undefined && !overUnit(line);

const columnWidths = (headers: readonly Inline[], natural: readonly number[], available: number): number[] | undefined => {
  const least = headers.map((header, column) => Math.max(displayWidth(header.text), Math.min(natural[column] ?? 0, WIDEST_GRAPHEME_COLUMNS)));
  let spare = available - least.reduce((sum, columns) => sum + columns, 0);
  if (spare < 0) return undefined;
  const widths = [...least];
  const order = widths.map((_, column) => column).sort((a, b) => (natural[a] ?? 0) - (least[a] ?? 0) - ((natural[b] ?? 0) - (least[b] ?? 0)) || a - b);
  order.forEach((column, rank) => {
    const wanted = (natural[column] ?? 0) - (least[column] ?? 0);
    const given = Math.min(wanted, Math.floor(spare / (order.length - rank)));
    widths[column] = (least[column] ?? 0) + given;
    spare -= given;
  });
  return widths;
};

const borderRow = (widths: readonly number[], left: string, middle: string, right: string): Row => {
  const text = `${left}${widths.map((columns) => '─'.repeat(columns + 2)).join(middle)}${right}`;
  return { text, spans: [[0, text.length, MARKDOWN_STYLE.border]], wrapped: false, prefixCols: 0 };
};

const gridRows = (cells: readonly Inline[], widths: readonly number[]): Row[] => {
  const wrapped = cells.map((cell, column) => wrapInline(cell, widths[column] ?? 0));
  const height = Math.max(...wrapped.map((rows) => rows.length));
  return Array.from({ length: height }, (_, index): Row => {
    const parts: (Inline | string)[] = [inlineOf('│', 'border')];
    wrapped.forEach((rows, column) => {
      const row = rows[index];
      const text = row?.text ?? '';
      parts.push(' ', { text, spans: [...(row?.spans ?? [])], links: [...(row?.links ?? [])] }, ' '.repeat(Math.max(0, (widths[column] ?? 0) - displayWidth(text)) + 1), inlineOf('│', 'border'));
    });
    const line = joined(parts);
    return { text: line.text, spans: line.spans, wrapped: false, prefixCols: 0, ...(line.links.length === 0 ? {} : { links: line.links }) };
  });
};

const EMPTY_ROW: Row = { text: '', spans: [], wrapped: false, prefixCols: 0 };

const recordRows = (headers: readonly Inline[], body: readonly (readonly Inline[])[], width: number): Row[] => {
  const records = body.length === 0 ? [headers.map(emptyInline)] : body;
  return records.flatMap((cells, index) => [
    ...(index === 0 ? [] : [EMPTY_ROW]),
    ...cells.flatMap((cell, column) => {
      const header = headers[column] ?? emptyInline();
      return wrapInline(header.text === '' ? cell : cell.text === '' ? header : joined([header, ': ', cell]), width);
    }),
  ]);
};

export type TableDrawing = 'grid' | 'records';

const tableRows = (lines: readonly string[], width: number, drawing: TableDrawing): Row[] => {
  const sources = lines.filter((_, index) => index !== 1).map(cellsOf);
  const columns = Math.max(...sources.map((cells) => cells.length));
  const [headers = [], ...body] = sources.map((cells, row) => Array.from({ length: columns }, (_, column) => inlineOf(cells[column] ?? '', row === 0 ? 'tableHeader' : undefined)));
  const natural = Array.from({ length: columns }, (_, column) => Math.max(...[headers, ...body].map((cells) => displayWidth(cells[column]?.text ?? ''))));
  const widths = columnWidths(headers, natural, width - (3 * columns + 1));
  if (widths === undefined || drawing === 'records') return recordRows(headers, body, width);
  return [borderRow(widths, '┌', '┬', '┐'), ...gridRows(headers, widths), borderRow(widths, '├', '┼', '┤'), ...body.flatMap((cells) => gridRows(cells, widths)), borderRow(widths, '└', '┴', '┘')];
};

export type BlockState = {
  readonly fence: Fence | undefined;
  readonly list: number | undefined;
  readonly paragraph: 'none' | 'top' | 'item';
  readonly records: readonly string[] | undefined;
};

const OUTSIDE: BlockState = { fence: undefined, list: undefined, paragraph: 'none', records: undefined };

export type ParsePoint = { readonly characters: number; readonly state: BlockState };

export const START_OF_TEXT: ParsePoint = { characters: 0, state: OUTSIDE };

type Look = (index: number) => string | undefined;

type Block = { rows: Row[]; next: number; state: BlockState };

const indentOf = (line: string): number => {
  let columns = 0;
  while (line[columns] === ' ') columns += 1;
  return columns;
};

const startsTable = (look: Look, index: number): boolean => {
  const line = look(index);
  return line !== undefined && line.includes('|') && isTableStart(line, look(index + 1));
};

const tableAt = (look: Look, index: number, width: number, drawing: TableDrawing): Block => {
  const lines = [look(index) ?? '', look(index + 1) ?? ''];
  let bytes = lines.reduce((sum, line) => sum + sourceBytes(line), 0);
  let end = index + 2;
  for (let row = look(end); isTableRow(row); row = look(end)) {
    if (bytes + sourceBytes(row) > MARKDOWN_UNIT_BYTES) return { rows: tableRows(lines, width, 'records'), next: end, state: { ...OUTSIDE, records: cellsOf(lines[0] ?? '') } };
    lines.push(row);
    bytes += sourceBytes(row);
    end += 1;
  }
  return { rows: tableRows(lines, width, drawing), next: end, state: OUTSIDE };
};

const recordAt = (line: string, headers: readonly string[], width: number): Row[] => [
  EMPTY_ROW,
  ...recordRows(
    headers.map((cell) => inlineOf(cell, 'tableHeader')),
    [cellsOf(line).map((cell) => inlineOf(cell))],
    width,
  ),
];

const continuesParagraph = (look: Look, index: number): boolean => {
  const line = look(index);
  if (line === undefined || line.trim() === '' || overUnit(line) || fenceOf(line) !== undefined) return false;
  if (HEADING.test(line) || QUOTE.test(line) || RULE.test(line) || UNDERLINE.test(line) || LIST_ITEM.test(line)) return false;
  return !startsTable(look, index);
};

const paragraphAt = (look: Look, index: number, state: BlockState, list: number | undefined, width: number): Block => {
  const lines = [look(index) ?? ''];
  let bytes = sourceBytes(lines[0] ?? '');
  let end = index + 1;
  for (; continuesParagraph(look, end); end += 1) {
    const line = look(end) ?? '';
    if (bytes + sourceBytes(line) > MARKDOWN_UNIT_BYTES) break;
    lines.push(line);
    bytes += sourceBytes(line);
  }
  const under = look(end);
  if (list === undefined && under !== undefined && UNDERLINE.test(under) && bytes + sourceBytes(under) <= MARKDOWN_UNIT_BYTES)
    return { rows: lines.flatMap((line) => wrapInline(inlineOf(line.trim(), 'heading'), width)), next: end + 1, state: OUTSIDE };
  return { rows: lines.flatMap((line) => lineRows(line, width)), next: end, state: { ...OUTSIDE, list, paragraph: list === undefined ? 'top' : 'item' } };
};

const blockAt = (look: Look, index: number, state: BlockState, width: number, drawing: TableDrawing): Block => {
  const line = look(index) ?? '';
  const one = (rows: Row[], next: BlockState): Block => ({ rows, next: index + 1, state: next });
  const fence = fenceOf(line);
  if (state.fence !== undefined) return fence !== undefined && closes(fence, state.fence) ? one([], { ...state, fence: undefined }) : one(codeRows(line, width, 'code'), state);
  if (state.records !== undefined) return isTableRow(line) ? one(recordAt(line, state.records, width), state) : blockAt(look, index, { ...state, records: undefined }, width, drawing);
  if (line.trim() === '') return one([EMPTY_ROW], { ...state, paragraph: 'none' });
  if (overUnit(line)) return one(wrapLine(line, width, { links: false }), OUTSIDE);
  const indent = indentOf(line);
  const inside = state.list !== undefined && indent >= state.list;
  const list = inside ? state.list : undefined;
  if (fence !== undefined) return one(languageRows(fence.info, width), { ...OUTSIDE, list, fence });
  const item = LIST_ITEM.exec(line);
  const codeFrom = (list ?? 0) + CODE_BLOCK_INDENT;
  if (indent >= codeFrom && state.paragraph === 'none' && (item === null || state.list === undefined)) return one(codeRows(line.slice(codeFrom), width, 'code'), { ...OUTSIDE, list });
  if (startsTable(look, index)) return tableAt(look, index, width, drawing);
  if (HEADING.test(line) || QUOTE.test(line) || RULE.test(line)) return one(lineRows(line, width), { ...OUTSIDE, list });
  if (item !== null) return one(lineRows(line, width), { ...OUTSIDE, paragraph: 'item', list: (item[1] ?? '').length + (item[2] ?? '').length + 1 });
  return paragraphAt(look, index, state, state.paragraph === 'item' ? state.list : list, width);
};

type Lines = { at(index: number): string | undefined; complete(index: number): boolean; startOf(index: number): number };

const linesOf = (text: string, from: number): Lines => {
  const shown: string[] = [];
  const ends: number[] = [];
  let ended = false;
  const read = (index: number): boolean => {
    while (ends.length <= index && !ended) {
      const start = ends.at(-1) ?? from;
      const found = text.indexOf('\n', start);
      ended = found === -1;
      const raw = text.slice(start, ended ? text.length : found);
      shown.push(inertText(!ended && raw.endsWith('\r') ? raw.slice(0, -1) : raw));
      ends.push(ended ? text.length : found + 1);
    }
    return index < ends.length;
  };
  return {
    at: (index) => (read(index) ? shown[index] : undefined),
    complete: (index) => read(index) && !(ended && index === ends.length - 1),
    startOf: (index) => (index === 0 ? from : read(index - 1) ? (ends[index - 1] ?? text.length) : text.length),
  };
};

export type Reading = { tables: TableDrawing; settled: boolean; unit: boolean };

export type Parsed = { rows: Row[]; point: ParsePoint; tail: Row[] | undefined };

export const parseMarkdown = (text: string, from: ParsePoint, width: number, reading: Reading): Parsed => {
  const lines = linesOf(text, from.characters);
  let examined = 0;
  const look: Look = (index) => {
    examined = Math.max(examined, index + 1);
    return lines.at(index);
  };
  const rows: Row[] = [];
  let index = 0;
  let { state } = from;
  let taken = 0;
  while (lines.at(index) !== undefined) {
    examined = 0;
    const block = blockAt(look, index, state, width, reading.tables);
    if (!reading.settled && !lines.complete(examined - 1)) break;
    const bytes = Buffer.byteLength(text.slice(lines.startOf(index), lines.startOf(block.next)));
    if (reading.unit && taken > 0 && taken + bytes > MARKDOWN_UNIT_BYTES) return { rows, point: { characters: lines.startOf(index), state }, tail: undefined };
    for (const row of block.rows) rows.push(row);
    index = block.next;
    state = block.state;
    taken += bytes;
  }
  const point: ParsePoint = { characters: lines.startOf(index), state };
  const tail: Row[] = [];
  while (lines.at(index) !== undefined) {
    const block = blockAt(look, index, state, width, reading.tables);
    for (const row of block.rows) tail.push(row);
    index = block.next;
    state = block.state;
  }
  return { rows, point, tail };
};

export const markdownRowsWith = (text: string, width: number, { tables }: { tables: TableDrawing }): Row[] => parseMarkdown(text, START_OF_TEXT, width, { tables, settled: true, unit: false }).rows;

export const markdownRows = (text: string, width: number): Row[] => markdownRowsWith(text, width, { tables: 'grid' });
