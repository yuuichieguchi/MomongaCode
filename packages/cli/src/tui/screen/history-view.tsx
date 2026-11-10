import { Box, Static } from 'ink';
import { useEffect, useEffectEvent, useState } from 'react';
import type { HistoryFeed } from './history-feed.ts';
import { RowText } from './row-text.tsx';
import type { TranscriptStore } from './store.ts';
import type { ViewSource } from './viewport.ts';
import type { Row } from './wrap.ts';

const HANDED: readonly Row[] = [];

const rowsFrom = (source: ViewSource, entryIndex: number, rowOffset: number): Row[] => {
  const rows: Row[] = [];
  for (let index = entryIndex; index < source.count(); index += 1) rows.push(...(index === entryIndex ? source.rowsOf(source.at(index)).slice(rowOffset) : source.rowsOf(source.at(index))));
  return rows;
};

export type HistoryViewProps = { store: Pick<TranscriptStore, 'settledCount'>; source: ViewSource; feed: HistoryFeed };

export function HistoryView({ store, source, feed }: HistoryViewProps) {
  const [chunks, setChunks] = useState<readonly (readonly Row[])[]>([]);
  const [caughtUp, setCaughtUp] = useState(false);
  const settled = store.settledCount();
  const pending = feed.pending(settled);
  if (!pending && !caughtUp) setCaughtUp(true);
  const handNext = useEffectEvent((): void => {
    const chunk = feed.next(source, store.settledCount());
    setChunks((handed) => [...handed.map(() => HANDED), chunk]);
  });
  useEffect(() => {
    if (!pending) return undefined;
    const turn = setImmediate(handNext);
    return () => clearImmediate(turn);
  }, [pending, settled, chunks.length]);
  const cursor = feed.cursor();
  const live = caughtUp ? rowsFrom(source, cursor.entryIndex, cursor.rowOffset) : rowsFrom(source, settled, 0);
  return (
    <>
      <Static items={[...chunks]}>
        {(chunk, index) => (
          <Box key={index} flexDirection="column">
            {chunk.map((row, rowIndex) => (
              <RowText key={rowIndex} row={row} />
            ))}
          </Box>
        )}
      </Static>
      {live.map((row, index) => (
        <RowText key={index} row={row} />
      ))}
    </>
  );
}
