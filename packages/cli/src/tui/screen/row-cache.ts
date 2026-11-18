import type { Entry } from '../transcript.ts';
import { answerRowsFrom, openThoughtRowsFrom, plainTextRows, rowsOfEntry } from './entry-rows.ts';
import type { AnswerReading } from './entry-rows.ts';
import { NO_FILE_LINKS } from './file-links.ts';
import type { FileLinks } from './file-links.ts';
import { NOTHING_SCANNED, START_OF_TEXT, referencesOf } from './markdown.ts';
import type { Parsed, ParsePoint, ReferenceScan } from './markdown.ts';
import type { ThoughtEntry, ThoughtWrap } from './thought.ts';
import type { RowFacts } from './tool-view.ts';
import type { StoreEntry, TranscriptStore } from './store.ts';
import type { Row } from './wrap.ts';

export type RowRenderers = {
  entryRows(entry: Entry, width: number): Row[];
  answerRows(text: string, from: ParsePoint, width: number, reading: AnswerReading): Parsed;
  plainRows(text: string, width: number): Row[];
  openThoughtRows(entry: ThoughtEntry, width: number, before: ThoughtWrap | undefined): ThoughtWrap;
};

export type ParseSchedule = { defer(run: () => void): void; onRows(): void };

type PlainLine = { start: number; end: number; ended: boolean; rows: Row[] };

type Answer = { text: string; settled: boolean; files: FileLinks; scan: ReferenceScan; point: ParsePoint; parsedRows: number; plain: PlainLine[]; parsed: boolean };

type Cached = { width: number; version: number; rows: Row[]; answer: Answer | undefined; thought: ThoughtWrap | undefined };

export type RowCache = {
  rowsOf(stored: StoreEntry, width: number): readonly Row[];
  parsed(stored: StoreEntry, width: number): boolean;
  retain(store: Pick<TranscriptStore, 'at' | 'count'>, firstIndex: number, lastIndex: number, marginRows: number, keepId?: number): void;
  size(): number;
  close(): void;
};

export const rowRenderersOf = (facts: RowFacts): RowRenderers => ({
  entryRows: (entry, width) => rowsOfEntry(entry, width, facts),
  answerRows: (text, from, width, reading) => answerRowsFrom(text, from, width, reading, facts),
  plainRows: plainTextRows,
  openThoughtRows: (entry, width, before) => openThoughtRowsFrom(entry, width, before, facts),
});

const appendTo = (rows: Row[], more: readonly Row[]): void => {
  for (const row of more) rows.push(row);
};

export const createRowCache = (renderers: RowRenderers, schedule: ParseSchedule): RowCache => {
  const cache = new Map<number, Cached>();
  const waiting: number[] = [];
  let turnAsked = false;
  let closed = false;

  const plainLinesOf = (answer: Answer, width: number): PlainLine[] => {
    const { text } = answer;
    const from = answer.point.characters;
    const kept = answer.plain.filter((line) => line.ended && line.start >= from);
    const lines = kept[0]?.start === from ? kept : [];
    for (let start = lines.at(-1)?.end ?? from, ended = true; ended; ) {
      const found = text.indexOf('\n', start);
      ended = found !== -1;
      const end = ended ? found + 1 : text.length;
      const raw = text.slice(start, ended ? found : end);
      lines.push({ start, end, ended, rows: renderers.plainRows(ended && raw.endsWith('\r') ? raw.slice(0, -1) : raw, width) });
      start = end;
    }
    return lines;
  };

  const showUnparsed = (cached: Cached, answer: Answer): void => {
    cached.rows.length = answer.parsedRows;
    answer.plain = plainLinesOf(answer, cached.width);
    for (const line of answer.plain) appendTo(cached.rows, line.rows);
  };

  const askTurn = (): void => {
    if (turnAsked || closed || waiting.length === 0) return;
    turnAsked = true;
    schedule.defer(turn);
  };

  const parseUnit = (id: number, cached: Cached, answer: Answer): void => {
    const unit = renderers.answerRows(answer.text, answer.point, cached.width, { references: answer.scan.references, files: answer.files, settled: answer.settled, unit: true });
    cached.rows.length = answer.parsedRows - unit.retract;
    appendTo(cached.rows, unit.rows);
    answer.point = unit.point;
    answer.parsedRows = cached.rows.length;
    answer.parsed = unit.tail !== undefined;
    if (unit.tail !== undefined) {
      appendTo(cached.rows, unit.tail);
      answer.plain = [];
      return;
    }
    showUnparsed(cached, answer);
    if (!waiting.includes(id)) waiting.push(id);
    askTurn();
  };

  function turn(): void {
    turnAsked = false;
    if (closed) return;
    for (let id = waiting.shift(); id !== undefined; id = waiting.shift()) {
      const cached = cache.get(id);
      if (cached?.answer === undefined || cached.answer.parsed) continue;
      parseUnit(id, cached, cached.answer);
      break;
    }
    askTurn();
    schedule.onRows();
  }

  const answerOf = (id: number, entry: Extract<Entry, { kind: 'assistant' }>, width: number, before: Cached | undefined): Cached => {
    const held = before !== undefined && before.width === width ? before.answer : undefined;
    const grown = held !== undefined && entry.text.startsWith(held.text) ? held : undefined;
    const scan = referencesOf(entry.text, grown?.scan ?? NOTHING_SCANNED, !entry.open);
    const files = entry.fileLinks ?? NO_FILE_LINKS;
    const continued = grown !== undefined && !(grown.parsed && grown.settled) && scan.references === grown.scan.references && files === grown.files;
    const answer: Answer = continued ? grown : { text: '', settled: false, files, scan, point: START_OF_TEXT, parsedRows: 0, plain: [], parsed: true };
    const cached: Cached = { width, version: 0, rows: continued && before !== undefined ? before.rows : [], answer, thought: undefined };
    const unitWaits = continued && !answer.parsed;
    answer.text = entry.text;
    answer.scan = scan;
    answer.settled = !entry.open;
    if (unitWaits) showUnparsed(cached, answer);
    else parseUnit(id, cached, answer);
    return cached;
  };

  const computed = (stored: StoreEntry, width: number, before: Cached | undefined): Cached => {
    const { entry } = stored;
    if (entry.kind === 'assistant') return answerOf(stored.id, entry, width, before);
    if (entry.kind === 'thought' && entry.endedAt === undefined) {
      const thought = renderers.openThoughtRows(entry, width, before?.thought);
      return { width, version: 0, rows: thought.rows, answer: undefined, thought };
    }
    return { width, version: 0, rows: renderers.entryRows(entry, width), answer: undefined, thought: undefined };
  };

  const unparsed = (cached: Cached | undefined): boolean => cached?.answer !== undefined && !cached.answer.parsed;

  return {
    rowsOf: (stored, width) => {
      const before = cache.get(stored.id);
      if (before !== undefined && before.width === width && before.version === stored.version) return before.rows;
      const next = computed(stored, width, before);
      next.version = stored.version;
      cache.set(stored.id, next);
      return next.rows;
    },
    parsed: (stored, width) => {
      const cached = cache.get(stored.id);
      return cached !== undefined && cached.width === width && cached.version === stored.version && !unparsed(cached);
    },
    retain: (store, firstIndex, lastIndex, marginRows, keepId) => {
      const kept = new Set<number>(keepId === undefined ? [] : [keepId]);
      for (let index = firstIndex; index <= lastIndex && index < store.count(); index += 1) kept.add(store.at(index).id);
      const walk = (start: number, step: 1 | -1): void => {
        let rows = 0;
        for (let index = start; index >= 0 && index < store.count() && rows < marginRows; index += step) {
          const { id } = store.at(index);
          const cached = cache.get(id);
          if (cached === undefined) return;
          kept.add(id);
          rows += cached.rows.length;
        }
      };
      walk(firstIndex - 1, -1);
      walk(lastIndex + 1, 1);
      for (const [id, cached] of [...cache]) if (!kept.has(id) && !unparsed(cached)) cache.delete(id);
    },
    size: () => cache.size,
    close: () => {
      closed = true;
      waiting.length = 0;
    },
  };
};
