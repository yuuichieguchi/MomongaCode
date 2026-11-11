import type { StyleToken } from './tokens.ts';
import { displayWidth, inertText, parseWebUrl, wrapLine } from './wrap.ts';
import type { Link, Row, Span } from './wrap.ts';

export const MARKDOWN_UNIT_BYTES = 16 * 1024;

const INLINE_NESTING_MAX = 8;
const WIDEST_GRAPHEME_COLUMNS = 2;
const CODE_INDENT = '  ';
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

const FENCE = /^\s*(?:```|~~~)/;
const FENCE_MARKS = /^\s*(?:`+|~+)\s*/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const HEADING = /^ {0,3}#{1,6} +/;
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

const inlineInto = (out: Inline, source: string, depth: number): void => {
  const unclosed = new Set<string>();
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
    const end = closer('`'.repeat(length), position + length, () => true);
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

const overUnit = (line: string): boolean => Buffer.byteLength(line) > MARKDOWN_UNIT_BYTES;

const withoutClosingMarks = (heading: string): string => {
  const trimmed = heading.trimEnd();
  let end = trimmed.length;
  while (trimmed[end - 1] === '#') end -= 1;
  return end < trimmed.length && (end === 0 || trimmed[end - 1] === ' ') ? trimmed.slice(0, end).trimEnd() : trimmed;
};

const lineRows = (line: string, width: number): Row[] => {
  if (overUnit(line)) return wrapLine(line, width, { links: false });
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

const cellsOf = (line: string): string[] => {
  const trimmed = line.trim();
  const inner = trimmed.slice(trimmed.startsWith('|') ? 1 : 0, trimmed.endsWith('|') && !trimmed.endsWith('\\|') && trimmed.length > 1 ? -1 : undefined);
  return inner.split(CELL_BAR).map((cell) => cell.trim().replaceAll('\\|', '|'));
};

const isTableStart = (header: string, delimiter: string | undefined): delimiter is string =>
  delimiter !== undefined && header.includes('|') && delimiter.includes('-') && !overUnit(header) && !overUnit(delimiter) && TABLE_DELIMITER.test(delimiter) && cellsOf(header).length === cellsOf(delimiter).length;

const isTableRow = (line: string | undefined): line is string => line !== undefined && line.includes('|') && line.trim() !== '' && !FENCE.test(line) && !overUnit(line);

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

export const markdownRowsWith = (text: string, width: number, { tables }: { tables: TableDrawing }): Row[] => {
  const lines = inertText(text).split('\n');
  const rows: Row[] = [];
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (FENCE.test(line)) {
      const language = fenced ? '' : line.replace(FENCE_MARKS, '').trim();
      if (language !== '') rows.push(...codeRows(language, width, 'language'));
      fenced = !fenced;
    } else if (fenced) rows.push(...codeRows(line, width, 'code'));
    else if (line.trim() === '') rows.push(EMPTY_ROW);
    else if (isTableStart(line, lines[index + 1])) {
      let end = index + 2;
      while (isTableRow(lines[end])) end += 1;
      rows.push(...tableRows(lines.slice(index, end), width, tables));
      index = end - 1;
    } else rows.push(...lineRows(line, width));
  }
  return rows;
};

export const markdownRows = (text: string, width: number): Row[] => markdownRowsWith(text, width, { tables: 'grid' });
