import { createElement, useEffect, useEffectEvent, useReducer, useRef } from 'react';
import type { ReactNode } from 'react';
import { DetailView, detailCapacity } from '../select.tsx';
import type { SelectFrame, TextRow } from '../select.tsx';
import type { KeyContext, KeyTable } from '../keys/table.ts';
import type { KeyEvent, TerminalEvent } from '../terminal/events.ts';
import { tickRunningTools, toggleNewestThought, toolOf } from '../transcript.ts';
import type { StoredResult, ToolEntry } from '../transcript.ts';
import type { ToolResultPage } from '@momonga/protocol';
import { STATIC_MARK } from './a11y.ts';
import type { A11y } from './a11y.ts';
import { WHEEL_ROWS } from './constants.ts';
import { fileLinksIn, NO_FILE_LINKS } from './file-links.ts';
import type { FileLinks } from './file-links.ts';
import { BLOCK_INDENT, DIFF_PREVIEW_ROWS, diffHeader, diffLines, diffRowCount, omittedText } from './diff.ts';
import type { ViewLine } from './diff.ts';
import type { ScreenTerminal } from './input.ts';
import { regionAt } from './layout.ts';
import type { RowAllocation } from './layout.ts';
import { MARKDOWN_UNIT_BYTES } from './markdown.ts';
import { byteLengthOf, ELLIPSIS, endWithinBytes } from './output-tail.ts';
import type { OutputTail } from './output-tail.ts';
import type { TranscriptStore } from './store.ts';
import { every } from './timers.ts';
import type { ScreenTimers } from './timers.ts';
import { styleOf } from './tokens.ts';
import type { ViewWindow } from './viewport.ts';
import { SPINNER_FRAMES } from './waiting-row.tsx';
import { displayWidth, inertText, segmentsOf, wrapLine } from './wrap.ts';
import type { Row } from './wrap.ts';

export const VIEWER_UNIT_BYTES = MARKDOWN_UNIT_BYTES;
export const TOOL_TICK_MS = 1000;

export type RowFacts = { readonly keys: KeyTable; readonly a11y: A11y };

const VIEWER_CONTEXTS: readonly KeyContext[] = ['viewer'];
const CHAT_CONTEXTS: readonly KeyContext[] = ['chat'];

export const expandRowText = (hidden: number, keys: KeyTable): string => {
  const key = keys.keyHint('transcript.detail');
  return `${ELLIPSIS} +${hidden} lines${key === '' ? '' : ` (${key} to expand)`}`;
};

const inertLine = (line: string): string => inertText(line.endsWith('\r') ? line.slice(0, -1) : line);

const cutToWidth = (text: string, width: number): string => {
  if (displayWidth(text) <= width) return text;
  let used = 0;
  let end = 0;
  for (const { index, width: cells, segment } of segmentsOf(text)) {
    if (used + cells > width - 1) break;
    used += cells;
    end = index + segment.length;
  }
  return `${text.slice(0, end)}${ELLIPSIS}`;
};

const cutRow = (line: ViewLine, width: number): Row => {
  const text = cutToWidth(`${line.prefix}${inertLine(line.text)}`, width);
  return { text, spans: line.token === undefined ? [] : [[0, text.length, line.token]], wrapped: false, prefixCols: Math.min(width, displayWidth(line.prefix)) };
};

const linkedRow = (row: Row, files: FileLinks): Row => {
  const links = fileLinksIn(row.text, files, [], []);
  return links.length === 0 ? row : { ...row, links };
};

const dimLine = (text: string): ViewLine => ({ prefix: BLOCK_INDENT, text, token: 'dim' });

const tailRows = (tail: OutputTail, width: number, keys: KeyTable): Row[] => [...(tail.hidden > 0 ? [dimLine(expandRowText(tail.hidden, keys))] : []), ...tail.lines.map(dimLine)].map((line) => cutRow(line, width));

const diffRows = (diff: NonNullable<ToolEntry['diff']>, width: number, keys: KeyTable): Row[] => {
  const header = cutRow({ prefix: '', text: diffHeader(diff) }, width);
  if (diff.hunks === undefined) return [header];
  const rows = [header];
  const lines = diffLines(diff.hunks);
  for (let drawn = 0; drawn < DIFF_PREVIEW_ROWS; drawn += 1) {
    const next = lines.next();
    if (next.done === true) break;
    rows.push(cutRow(next.value, width));
  }
  const hidden = diffRowCount(diff.hunks) - DIFF_PREVIEW_ROWS;
  if (hidden > 0) rows.push(cutRow(dimLine(expandRowText(hidden, keys)), width));
  if (diff.omitted !== undefined) rows.push(cutRow(dimLine(omittedText(diff.omitted)), width));
  return rows;
};

export const toolBlockRows = (entry: ToolEntry, width: number, keys: KeyTable): Row[] => {
  if (entry.denial !== undefined) return [];
  if (entry.diff !== undefined) {
    const [header, ...rest] = diffRows(entry.diff, width, keys);
    return header === undefined ? rest : [linkedRow(header, entry.fileLinks ?? NO_FILE_LINKS), ...rest];
  }
  return entry.tail === undefined ? [] : tailRows(entry.tail, width, keys);
};

export const elapsedSecondsOf = (entry: ToolEntry): number => Math.max(0, Math.floor((entry.shownAt - entry.calledAt) / 1000));

export const runningToolText = (entry: ToolEntry, a11y: A11y): string => {
  const seconds = elapsedSecondsOf(entry);
  return `${a11y.reducedMotion ? STATIC_MARK : SPINNER_FRAMES[seconds % SPINNER_FRAMES.length]} ${entry.title} · ${seconds}s`;
};


export const hasOutput = (entry: ToolEntry): boolean => entry.denial === undefined && (entry.diff !== undefined || entry.tail !== undefined);

export const isExpandRow = (row: Row): boolean => row.prefixCols === BLOCK_INDENT.length && /^ {2}… \+\d+ lines/.test(row.text);

export function* outputViewLines(output: string): Generator<ViewLine> {
  const end = output.endsWith('\n') ? output.length - 1 : output.length;
  if (end === 0) return;
  let from = 0;
  while (from <= end) {
    const found = output.indexOf('\n', from);
    const stop = found === -1 || found > end ? end : found;
    let continued = false;
    do {
      const to = endWithinBytes(output, from, stop, VIEWER_UNIT_BYTES);
      yield { prefix: '', text: output.slice(from, to), ...(continued ? { continued } : {}) };
      continued = true;
      from = to;
    } while (from < stop);
    from = stop + 1;
  }
}

function* diffViewLines(diff: NonNullable<ToolEntry['diff']>): Generator<ViewLine> {
  yield { prefix: '', text: diffHeader(diff) };
  if (diff.hunks === undefined) return;
  yield* diffLines(diff.hunks);
  if (diff.omitted !== undefined) yield dimLine(omittedText(diff.omitted));
}

export const entryViewLines = (entry: ToolEntry): Iterator<ViewLine> => (entry.diff !== undefined ? diffViewLines(entry.diff) : outputViewLines(entry.output ?? ''));

export type StoredResultReader = (stored: StoredResult, offset: number) => Promise<ToolResultPage>;

export const storedOutputOf = async (read: StoredResultReader, stored: StoredResult): Promise<string> => {
  const pages: string[] = [];
  for (let offset: number | null = 0; offset !== null; ) {
    const page: ToolResultPage = await read(stored, offset);
    if (page.next !== null && page.next <= offset) throw new Error(`the stored result of ${stored.callId} did not advance past byte ${offset}`);
    pages.push(page.text);
    offset = page.next;
  }
  return pages.join('');
};

export const fullViewLines = async (entry: ToolEntry, read: StoredResultReader): Promise<Iterator<ViewLine>> =>
  entry.diff !== undefined || entry.stored === undefined ? entryViewLines(entry) : outputViewLines(await storedOutputOf(read, entry.stored));

export type Pager = { readonly rows: readonly Row[]; complete(): boolean; fillUnit(): void; fill(through: number): void };

export const createPager = (lines: Iterator<ViewLine>, width: number): Pager => {
  const rows: Row[] = [];
  let done = false;
  const fillUnit = (): void => {
    for (let taken = 0; !done && taken < VIEWER_UNIT_BYTES; ) {
      const next = lines.next();
      if (next.done === true) {
        done = true;
        return;
      }
      const line = next.value;
      taken += byteLengthOf(line.text) + 1;
      const wrapped = wrapLine(inertLine(line.text), width, { first: line.prefix, rest: ' '.repeat(displayWidth(line.prefix)), links: false, ...(line.token === undefined ? {} : { token: line.token }) });
      wrapped.forEach((row, index) => rows.push(index === 0 && line.continued === true ? { ...row, wrapped: true } : row));
    }
  };
  return {
    rows,
    complete: () => done,
    fillUnit,
    fill: (through) => {
      while (!done && rows.length < through) fillUnit();
    },
  };
};

const textRowOf = (row: Row): TextRow => {
  const style = styleOf(row.spans.map((span) => span[2]));
  return { text: row.text, ...(style.color === undefined ? {} : { color: style.color }), ...(style.dimColor === true ? { dim: true } : {}), ...(style.bold === true ? { bold: true } : {}) };
};

export type ToolViewHost = {
  store: TranscriptStore;
  terminal: ScreenTerminal;
  now(): number;
  timers: ScreenTimers;
  keys: KeyTable;
  a11y: A11y;
  frame: SelectFrame;
  yielded: boolean;
  window: ViewWindow | undefined;
  allocation: RowAllocation;
  readStoredResult: StoredResultReader;
  reportError(error: unknown): void;
};

export type ToolView = { shown: boolean; view: ReactNode; showNewest(): void; key(event: KeyEvent, keys: KeyTable): boolean; expandsAt(screenRow: number): boolean };

type Opened = { callId: string; index: number; width: number; lines: () => Iterator<ViewLine>; pager: Pager; top: number };

const toolAt = (store: TranscriptStore, index: number): ToolEntry | undefined => {
  const { entry } = store.at(index);
  return entry.kind === 'tool' ? entry : undefined;
};

const findTool = (store: TranscriptStore, from: number, step: 1 | -1, wanted: (entry: ToolEntry) => boolean): { index: number; entry: ToolEntry } | undefined => {
  for (let index = from; index >= 0 && index < store.count(); index += step) {
    const entry = toolAt(store, index);
    if (entry !== undefined && wanted(entry)) return { index, entry };
  }
  return undefined;
};

export const useToolView = (host: ToolViewHost): ToolView => {
  const { store, terminal, timers, now } = host;
  const opened = useRef<Opened | undefined>(undefined);
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const running = store.state().runningTools.length > 0 && !host.a11y.screenReader;

  useEffect(() => (running ? every(timers, TOOL_TICK_MS, () => tickRunningTools(store, now())) : undefined), [running, timers, now, store]);

  const capacity = (): number => detailCapacity(host.frame);

  const place = (target: Opened, top: number): void => {
    target.pager.fill(Math.max(0, top) + capacity() + 1);
    target.top = Math.max(0, Math.min(top, target.pager.rows.length - capacity()));
    redraw();
  };

  const open = (index: number, entry: ToolEntry): void => {
    const lines = (): Iterator<ViewLine> => entryViewLines(entry);
    const next: Opened = { callId: entry.callId, index, width: host.frame.width, lines, pager: createPager(lines(), host.frame.width), top: 0 };
    opened.current = next;
    place(next, 0);
    if (entry.diff !== undefined || entry.stored === undefined) return;
    storedOutputOf(host.readStoredResult, entry.stored)
      .then((full) => {
        const shown = opened.current;
        if (shown?.callId !== entry.callId || shown.index !== index) return;
        const fullLines = (): Iterator<ViewLine> => outputViewLines(full);
        const loaded: Opened = { ...shown, lines: fullLines, pager: createPager(fullLines(), shown.width) };
        opened.current = loaded;
        place(loaded, shown.top);
      })
      .catch(host.reportError);
  };

  const close = (): void => {
    opened.current = undefined;
    redraw();
  };

  const current = (): Opened | undefined => {
    const shown = opened.current;
    if (shown === undefined || host.yielded) return undefined;
    if (shown.width === host.frame.width) return shown;
    const entry = toolOf(store, shown.callId);
    if (entry === undefined) return undefined;
    const rewrapped: Opened = { ...shown, width: host.frame.width, pager: createPager(shown.lines(), host.frame.width), top: 0 };
    rewrapped.pager.fill(capacity() + 1);
    opened.current = rewrapped;
    return rewrapped;
  };

  const toEnd = async (target: Opened): Promise<void> => {
    while (!target.pager.complete()) {
      target.pager.fillUnit();
      await new Promise<void>((resolve) => {
        timers.setTimeout(resolve, 0);
      });
      if (opened.current !== target) return;
    }
    place(target, target.pager.rows.length);
  };

  const step = (target: Opened, direction: 1 | -1): void => {
    const found = findTool(store, target.index + direction, direction, hasOutput);
    if (found !== undefined) open(found.index, found.entry);
  };

  const showNewest = (): void => {
    const { newestThought, newestExpandableTool } = store.state();
    const newest = newestExpandableTool === undefined ? undefined : store.byKey(newestExpandableTool);
    const index = newest === undefined ? undefined : store.indexOfId(newest.id);
    const tool = index === undefined || newest?.entry.kind !== 'tool' ? undefined : { index, entry: newest.entry };
    const thought = newestThought === undefined ? undefined : store.byKey(newestThought);
    if (tool !== undefined && (thought === undefined || store.at(tool.index).id > thought.id)) open(tool.index, tool.entry);
    else if (thought !== undefined) toggleNewestThought(store);
  };

  const key = (event: KeyEvent, keys: KeyTable): boolean => {
    const shown = current();
    if (shown === undefined) return false;
    const action = keys.actionOf(VIEWER_CONTEXTS, event, 'plain');
    if (action === undefined) return keys.actionOf(CHAT_CONTEXTS, event) !== 'prompt.interrupt';
    if (action === 'viewer.close') close();
    else if (action === 'viewer.older') step(shown, -1);
    else if (action === 'viewer.newer') step(shown, 1);
    else if (action === 'viewer.up') place(shown, shown.top - 1);
    else if (action === 'viewer.down') place(shown, shown.top + 1);
    else if (action === 'viewer.pageUp') place(shown, shown.top - capacity());
    else if (action === 'viewer.pageDown') place(shown, shown.top + capacity());
    else if (action === 'viewer.first') place(shown, 0);
    else if (action === 'viewer.last') toEnd(shown).catch(host.reportError);
    return true;
  };

  const expandAt = (screenRow: number): { index: number; entry: ToolEntry } | undefined => {
    if (host.window === undefined || host.yielded || current() !== undefined) return undefined;
    const hit = regionAt(host.allocation, screenRow);
    const visible = hit?.region === 'viewport' ? host.window.rows[hit.row] : undefined;
    const index = visible === undefined ? undefined : store.indexOfId(visible.entryId);
    const entry = index === undefined ? undefined : toolAt(store, index);
    return visible !== undefined && index !== undefined && entry !== undefined && isExpandRow(visible.row) ? { index, entry } : undefined;
  };

  const onEvent = useEffectEvent((event: TerminalEvent): boolean => {
    if (event.type !== 'mouse') return false;
    const shown = current();
    if (shown !== undefined) {
      if (event.button === 'wheel-up') place(shown, shown.top - WHEEL_ROWS);
      else if (event.button === 'wheel-down') place(shown, shown.top + WHEEL_ROWS);
      return true;
    }
    if (event.kind !== 'release' || event.button !== 'left') return false;
    const expand = expandAt(event.row);
    if (expand !== undefined) open(expand.index, expand.entry);
    return false;
  });

  useEffect(() => terminal.input.claim('tool-view', (event) => onEvent(event)), [terminal]);

  const shown = current();
  return {
    shown: shown !== undefined,
    view: shown === undefined ? null : createElement(DetailView, { text: shown.pager.rows.slice(shown.top, shown.top + capacity()).map(textRowOf), frame: host.frame, top: 0, keys: host.keys }),
    showNewest,
    key,
    expandsAt: (screenRow) => expandAt(screenRow) !== undefined,
  };
};
