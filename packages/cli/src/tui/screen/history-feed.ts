import { SWITCH_CHUNK_ROWS } from './constants.ts';
import type { ViewSource } from './viewport.ts';
import type { Row } from './wrap.ts';

export type HistoryFeed = {
  pending(settled: number): boolean;
  next(source: ViewSource, settled: number): Row[];
  handed(): number;
  cursor(): { entryIndex: number; rowOffset: number };
};

export const createHistoryFeed = (printed = 0): HistoryFeed => {
  let entryIndex = printed;
  let rowOffset = 0;
  return {
    pending: (settled) => entryIndex < settled,
    next: (source, settled) => {
      const chunk: Row[] = [];
      while (entryIndex < settled && chunk.length < SWITCH_CHUNK_ROWS) {
        const rows = source.rowsOf(source.at(entryIndex));
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
    cursor: () => ({ entryIndex, rowOffset }),
  };
};
