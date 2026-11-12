import { Box, renderToString, useStdout } from 'ink';
import { useEffect, useEffectEvent, useState } from 'react';
import type { NegotiationState } from '../terminal/negotiation.ts';
import type { HistoryFeed } from './history-feed.ts';
import { RowText } from './row-text.tsx';
import type { TranscriptStore } from './store.ts';
import type { ScreenTimers } from './timers.ts';
import type { ViewSource } from './viewport.ts';
import type { Row } from './wrap.ts';

export const BACKGROUND_ANSWER_WAIT_MS = 1000;

const NEXT_TURN_MS = 0;

export const useBackgroundAnswered = (negotiation: NegotiationState, timers: ScreenTimers): boolean => {
  const [expired, setExpired] = useState(false);
  const answered = negotiation !== 'unknown';
  useEffect(() => {
    if (answered || expired) return undefined;
    const timer = timers.setTimeout(() => setExpired(true), BACKGROUND_ANSWER_WAIT_MS);
    return () => timers.clearTimeout(timer);
  }, [answered, expired, timers]);
  return answered || expired;
};

function Rows({ rows }: { rows: readonly Row[] }) {
  return (
    <Box flexDirection="column">
      {rows.map((row, index) => (
        <RowText key={index} row={row} />
      ))}
    </Box>
  );
}

export type HistoryViewProps = { store: Pick<TranscriptStore, 'settledAt'>; source: ViewSource; feed: HistoryFeed; ready: boolean; timers: ScreenTimers; columns: number };

export function HistoryView({ store, source, feed, ready, timers, columns }: HistoryViewProps) {
  const { write } = useStdout();
  const [turns, setTurns] = useState(0);
  const pending = ready && feed.pending(source, store.settledAt);
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
