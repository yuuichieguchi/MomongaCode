import { SWITCH_CHUNK_ROWS } from './constants.ts';
import type { ViewSource } from './viewport.ts';
import type { Row } from './wrap.ts';

export type SettledAt = (index: number) => boolean;

export type HistoryFeed = {
  pending(source: ViewSource, settled: SettledAt): boolean;
  next(source: ViewSource, settled: SettledAt): Row[];
  handed(): number;
  live(source: ViewSource, settled: SettledAt): Row[];
};

export const createHistoryFeed = (printed = 0): HistoryFeed => {
  let floor = printed;
  const above = new Set<number>();
  let partial: { index: number; offset: number } | undefined;
  let caughtUp = false;
  const isHanded = (index: number): boolean => index < floor || above.has(index);
  const markHanded = (index: number): void => {
    above.add(index);
    while (above.has(floor)) {
      above.delete(floor);
      floor += 1;
    }
  };
  const waiting = (source: ViewSource, settled: SettledAt): boolean => {
    for (let index = floor; index < source.count(); index += 1) if (!isHanded(index) && settled(index)) return true;
    return false;
  };
  return {
    pending: waiting,
    next: (source, settled) => {
      const chunk: Row[] = [];
      for (let index = floor; index < source.count() && chunk.length < SWITCH_CHUNK_ROWS; index += 1) {
        if (isHanded(index) || !settled(index)) continue;
        const entry = source.at(index);
        const rows = source.rowsOf(entry);
        if (!source.parsed(entry)) break;
        const offset = partial?.index === index ? partial.offset : 0;
        const taken = rows.slice(offset, offset + SWITCH_CHUNK_ROWS - chunk.length);
        chunk.push(...taken);
        if (offset + taken.length < rows.length) {
          partial = { index, offset: offset + taken.length };
          break;
        }
        partial = undefined;
        markHanded(index);
      }
      return chunk;
    },
    handed: () => floor,
    live: (source, settled) => {
      caughtUp ||= !waiting(source, settled);
      const rows: Row[] = [];
      for (let index = floor; index < source.count(); index += 1) {
        if (isHanded(index) || (!caughtUp && settled(index))) continue;
        const all = source.rowsOf(source.at(index));
        rows.push(...(partial?.index === index ? all.slice(partial.offset) : all));
      }
      return rows;
    },
  };
};
