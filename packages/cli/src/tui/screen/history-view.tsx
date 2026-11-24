import { Box, renderToString, useStdout } from 'ink';
import { useEffect, useEffectEvent, useState } from 'react';
import type { HistoryFeed } from './history-feed.ts';
import { RowText } from './row-text.tsx';
import type { TranscriptStore } from './store.ts';
import type { ScreenTimers } from './timers.ts';
import type { ViewSource } from './viewport.ts';
import type { Row } from './wrap.ts';

const NEXT_TURN_MS = 0;

function Rows({ rows }: { rows: readonly Row[] }) {
  return (
    <Box flexDirection="column">
      {rows.map((row, index) => (
        <RowText key={index} row={row} />
      ))}
    </Box>
  );
}

export type HistoryViewProps = { store: Pick<TranscriptStore, 'settledAt'>; source: ViewSource; feed: HistoryFeed; timers: ScreenTimers; columns: number };

export function HistoryView({ store, source, feed, timers, columns }: HistoryViewProps) {
  const { write } = useStdout();
  const [turns, setTurns] = useState(0);
  const pending = feed.pending(source, store.settledAt);
  const handNext = useEffectEvent((): void => {
    const chunk = feed.next(source, store.settledAt);
    if (chunk.length > 0) write(`${renderToString(<Rows rows={chunk} />, { columns })}\n`);
    setTurns((count) => count + 1);
  });
  useEffect(() => {
    if (!pending) return undefined;
    const turn = timers.setTimeout(handNext, NEXT_TURN_MS);
    return () => timers.clearTimeout(turn);
  }, [pending, turns, source, timers]);
  return <Rows rows={feed.live(source, store.settledAt)} />;
}
