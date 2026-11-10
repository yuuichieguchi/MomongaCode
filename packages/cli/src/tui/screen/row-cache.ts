import type { Entry } from '../transcript.ts';
import { assistantTextRows, rowsOfEntry } from './entry-rows.ts';
import type { RowFacts } from './tool-view.ts';
import type { StoreEntry, TranscriptStore } from './store.ts';
import type { Row } from './wrap.ts';

export type RowRenderers = { entryRows(entry: Entry, width: number): Row[]; assistantRows(text: string, width: number): Row[] };

type Stable = { characters: number; rows: number; fenced: boolean };

type Cached = { width: number; version: number; rows: Row[]; stable: Stable | undefined };

export type RowCache = {
  rowsOf(stored: StoreEntry, width: number): readonly Row[];
  retain(store: Pick<TranscriptStore, 'at' | 'count'>, firstIndex: number, lastIndex: number, marginRows: number, keepId?: number): void;
  size(): number;
};

const FENCE = /^\s*(?:```|~~~)/;

const UNSTABLE: Stable = { characters: 0, rows: 0, fenced: false };

const stableAfter = (text: string, from: Stable): { characters: number; fenced: boolean } => {
  let fenced = from.fenced;
  let boundary = from.characters;
  let position = from.characters;
  for (let end = text.indexOf('\n', position); end >= 0; end = text.indexOf('\n', position)) {
    const line = text.slice(position, end);
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced && line.trim() === '') boundary = end + 1;
    position = end + 1;
  }
  return { characters: boundary, fenced: boundary === from.characters ? from.fenced : false };
};

const segmentOf = (text: string, from: number, boundary: number): string => {
  const segment = text.slice(from, boundary - 1);
  return segment.endsWith('\r') ? segment.slice(0, -1) : segment;
};

export const rowRenderersOf = (facts: RowFacts): RowRenderers => ({ entryRows: (entry, width) => rowsOfEntry(entry, width, facts), assistantRows: (text, width) => assistantTextRows(text, width, facts) });

export const createRowCache = (renderers: RowRenderers): RowCache => {
  const cache = new Map<number, Cached>();

  const answerRows = (text: string, width: number, before: Cached | undefined): Cached => {
    const reusable = before !== undefined && before.width === width && before.stable !== undefined;
    const rows = reusable ? before.rows : [];
    const from = reusable && before.stable !== undefined ? before.stable : UNSTABLE;
    rows.length = from.rows;
    const next = stableAfter(text, from);
    if (next.characters > from.characters) rows.push(...renderers.assistantRows(segmentOf(text, from.characters, next.characters), width));
    const stable: Stable = { characters: next.characters, rows: rows.length, fenced: next.fenced };
    rows.push(...renderers.assistantRows(text.slice(next.characters), width));
    return { width, version: 0, rows, stable };
  };

  return {
    rowsOf: (stored, width) => {
      const before = cache.get(stored.id);
      if (before !== undefined && before.width === width && before.version === stored.version) return before.rows;
      const { entry } = stored;
      const computed: Cached = entry.kind === 'assistant' ? answerRows(entry.text, width, before) : { width, version: 0, rows: renderers.entryRows(entry, width), stable: undefined };
      cache.set(stored.id, { ...computed, version: stored.version });
      return computed.rows;
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
      for (const id of [...cache.keys()]) if (!kept.has(id)) cache.delete(id);
    },
    size: () => cache.size,
  };
};
