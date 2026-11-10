import { createElement, useEffect, useEffectEvent, useReducer, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Key } from 'ink';
import { escapeTerminalBlock } from '@momonga/protocol';
import { DetailView, detailCapacity } from '../select.tsx';
import type { SelectFrame, TextRow } from '../select.tsx';
import type { TerminalEvent } from '../terminal/events.ts';
import { tickRunningTools, toggleNewestThought, toolOf } from '../transcript.ts';
import type { ToolEntry } from '../transcript.ts';
import { WHEEL_ROWS } from './constants.ts';
import { BLOCK_INDENT, DIFF_PREVIEW_ROWS, diffHeader, diffLines, diffRowCount, omittedText } from './diff.ts';
import type { ViewLine } from './diff.ts';
import type { ScreenTerminal } from './input.ts';
import { regionAt } from './layout.ts';
import type { RowAllocation } from './layout.ts';
import { MARKDOWN_UNIT_BYTES } from './markdown.ts';
import type { TranscriptStore } from './store.ts';
import { every } from './timers.ts';
import type { ScreenTimers } from './timers.ts';
import { styleOf } from './tokens.ts';
import type { ViewWindow } from './viewport.ts';
import { SPINNER_FRAMES } from './waiting-row.tsx';
import { displayWidth, segmentsOf, withoutTabs, wrapLine } from './wrap.ts';
import type { Row } from './wrap.ts';

export const OUTPUT_TAIL_MAX_BYTES = 8 * 1024;
export const OUTPUT_TAIL_LINES = 5;
export const VIEWER_UNIT_BYTES = MARKDOWN_UNIT_BYTES;
export const VIEWER_KEY = 'ctrl+o';
export const TOOL_TICK_MS = 1000;

const ELLIPSIS = '…';
const LOW_SURROGATE = /^[\uDC00-\uDFFF]/;

export type OutputTail = { lines: readonly string[]; hidden: number };

export const expandRowText = (hidden: number): string => `${ELLIPSIS} +${hidden} lines (${VIEWER_KEY} to expand)`;

export const tailOf = (output: string): OutputTail | undefined => {
  const end = output.endsWith('\n') ? output.length - 1 : output.length;
  if (end === 0) return undefined;
  const start = Math.max(0, end - OUTPUT_TAIL_MAX_BYTES);
  const from = LOW_SURROGATE.test(output.charAt(start)) ? start + 1 : start;
  const within = output.slice(from, end).split('\n');
  const kept = within.slice(-OUTPUT_TAIL_LINES);
  let total = 1;
  for (let at = output.indexOf('\n'); at !== -1 && at < end; at = output.indexOf('\n', at + 1)) total += 1;
  const lines = from > 0 && kept.length === within.length ? [`${ELLIPSIS}${kept[0] ?? ''}`, ...kept.slice(1)] : kept;
  return { lines, hidden: total - lines.length };
};

const inertLine = (line: string): string => withoutTabs(escapeTerminalBlock(line.endsWith('\r') ? line.slice(0, -1) : line));

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

const dimLine = (text: string): ViewLine => ({ prefix: BLOCK_INDENT, text, token: 'dim' });

const tailRows = (tail: OutputTail, width: number): Row[] => [...(tail.hidden > 0 ? [dimLine(expandRowText(tail.hidden))] : []), ...tail.lines.map(dimLine)].map((line) => cutRow(line, width));

const diffRows = (diff: NonNullable<ToolEntry['diff']>, width: number): Row[] => {
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
  if (hidden > 0) rows.push(cutRow(dimLine(expandRowText(hidden)), width));
  if (diff.omitted !== undefined) rows.push(cutRow(dimLine(omittedText(diff.omitted)), width));
  return rows;
};

export const toolBlockRows = (entry: ToolEntry, width: number): Row[] => {
  if (entry.denial !== undefined) return [];
  if (entry.diff !== undefined) return diffRows(entry.diff, width);
  return entry.tail === undefined ? [] : tailRows(entry.tail, width);
};

export const elapsedSecondsOf = (entry: ToolEntry): number => Math.max(0, Math.floor((entry.shownAt - entry.calledAt) / 1000));

export const runningToolText = (entry: ToolEntry): string => {
  const seconds = elapsedSecondsOf(entry);
  return `${SPINNER_FRAMES[seconds % SPINNER_FRAMES.length]} ${entry.title} · ${seconds}s`;
};

export const hasHiddenLines = (entry: ToolEntry): boolean => {
  if (entry.denial !== undefined) return false;
  if (entry.diff !== undefined) return entry.diff.hunks !== undefined && diffRowCount(entry.diff.hunks) > DIFF_PREVIEW_ROWS;
  return entry.tail !== undefined && entry.tail.hidden > 0;
};

export const hasOutput = (entry: ToolEntry): boolean => entry.denial === undefined && (entry.diff !== undefined || entry.tail !== undefined);

export const isExpandRow = (row: Row): boolean => row.prefixCols === BLOCK_INDENT.length && /^ {2}… \+\d+ lines \(/.test(row.text);

function* outputLines(output: string): Generator<ViewLine> {
  const end = output.endsWith('\n') ? output.length - 1 : output.length;
  if (end === 0) return;
  let from = 0;
  while (from <= end) {
    const found = output.indexOf('\n', from);
    const stop = found === -1 || found > end ? end : found;
    let continued = false;
    do {
      const to = Math.min(stop, from + VIEWER_UNIT_BYTES);
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

export const entryViewLines = (entry: ToolEntry): Iterator<ViewLine> => (entry.diff !== undefined ? diffViewLines(entry.diff) : outputLines(entry.output ?? ''));

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
      taken += line.text.length + 1;
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
  frame: SelectFrame;
  yielded: boolean;
  window: ViewWindow | undefined;
  allocation: RowAllocation;
  reportError(error: unknown): void;
};

export type ToolView = { shown: boolean; view: ReactNode; showNewest(): void; key(input: string, key: Key): boolean };

type Opened = { callId: string; index: number; width: number; pager: Pager; top: number };

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
  const running = store.state().runningTools.length > 0;

  useEffect(() => (running ? every(timers, TOOL_TICK_MS, () => tickRunningTools(store, now())) : undefined), [running, timers, now, store]);

  const capacity = (): number => detailCapacity(host.frame);

  const place = (target: Opened, top: number): void => {
    target.pager.fill(Math.max(0, top) + capacity() + 1);
    target.top = Math.max(0, Math.min(top, target.pager.rows.length - capacity()));
    redraw();
  };

  const open = (index: number, entry: ToolEntry): void => {
    const next: Opened = { callId: entry.callId, index, width: host.frame.width, pager: createPager(entryViewLines(entry), host.frame.width), top: 0 };
    opened.current = next;
    place(next, 0);
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
    const rewrapped: Opened = { ...shown, width: host.frame.width, pager: createPager(entryViewLines(entry), host.frame.width), top: 0 };
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
    const tool = findTool(store, store.count() - 1, -1, hasHiddenLines);
    const { newestThought } = store.state();
    const thought = newestThought === undefined ? undefined : store.byKey(newestThought);
    if (tool !== undefined && (thought === undefined || store.at(tool.index).id > thought.id)) open(tool.index, tool.entry);
    else if (thought !== undefined) toggleNewestThought(store);
  };

  const key = (input: string, pressed: Key): boolean => {
    const shown = current();
    if (shown === undefined) return false;
    if (pressed.ctrl && input === 'c') return false;
    if (pressed.escape) close();
    else if (pressed.tab) step(shown, pressed.shift ? 1 : -1);
    else if (pressed.upArrow) place(shown, shown.top - 1);
    else if (pressed.downArrow) place(shown, shown.top + 1);
    else if (pressed.pageUp) place(shown, shown.top - capacity());
    else if (pressed.pageDown) place(shown, shown.top + capacity());
    else if (pressed.home) place(shown, 0);
    else if (pressed.end) toEnd(shown).catch(host.reportError);
    return true;
  };

  const onEvent = useEffectEvent((event: TerminalEvent): boolean => {
    if (event.type !== 'mouse') return false;
    const shown = current();
    if (shown !== undefined) {
      if (event.button === 'wheel-up') place(shown, shown.top - WHEEL_ROWS);
      else if (event.button === 'wheel-down') place(shown, shown.top + WHEEL_ROWS);
      return true;
    }
    if (host.window === undefined || host.yielded || event.kind !== 'release' || event.button !== 'left') return false;
    const hit = regionAt(host.allocation, event.row);
    const visible = hit?.region === 'viewport' ? host.window.rows[hit.row] : undefined;
    const index = visible === undefined ? undefined : store.indexOfId(visible.entryId);
    const entry = index === undefined ? undefined : toolAt(store, index);
    if (visible !== undefined && index !== undefined && entry !== undefined && isExpandRow(visible.row)) open(index, entry);
    return false;
  });

  useEffect(() => terminal.input.claim((event) => onEvent(event)), [terminal]);

  const shown = current();
  return {
    shown: shown !== undefined,
    view: shown === undefined ? null : createElement(DetailView, { text: shown.pager.rows.slice(shown.top, shown.top + capacity()).map(textRowOf), frame: host.frame, top: 0 }),
    showNewest,
    key,
  };
};
