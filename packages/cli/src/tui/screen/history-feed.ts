import { SWITCH_CHUNK_ROWS } from './constants.ts';
import type { ViewSource } from './viewport.ts';
import type { Row } from './wrap.ts';

export type HistoryFeed = {
  pending(settled: number): boolean;
  next(source: ViewSource, settled: number): Row[];
  handed(): number;
  live(source: ViewSource, settled: number): Row[];
};

const rowsFrom = (source: ViewSource, entryIndex: number, rowOffset: number): Row[] => {
  const rows: Row[] = [];
  for (let index = entryIndex; index < source.count(); index += 1) rows.push(...(index === entryIndex ? source.rowsOf(source.at(index)).slice(rowOffset) : source.rowsOf(source.at(index))));
  return rows;
};

export const createHistoryFeed = (printed = 0): HistoryFeed => {
  let entryIndex = printed;
  let rowOffset = 0;
  let caughtUp = false;
  return {
    pending: (settled) => entryIndex < settled,
    next: (source, settled) => {
      const chunk: Row[] = [];
      while (entryIndex < settled && chunk.length < SWITCH_CHUNK_ROWS) {
        const entry = source.at(entryIndex);
        const rows = source.rowsOf(entry);
        if (!source.parsed(entry)) break;
        const taken = rows.slice(rowOffset, rowOffset + SWITCH_CHUNK_ROWS - chunk.length);
        chunk.push(...taken);
        rowOffset += taken.length;
        if (rowOffset < rows.length) break;
        entryIndex += 1;
        rowOffset = 0;
      }
      return chunk;
    },
    handed: () => entryIndex,
    live: (source, settled) => {
      caughtUp ||= entryIndex >= settled;
      return caughtUp ? rowsFrom(source, entryIndex, rowOffset) : rowsFrom(source, settled, 0);
    },
  };
};
