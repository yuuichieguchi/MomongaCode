import { Box, Text, useStdout } from 'ink';
import { useEffect, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { WINDOW_TOO_SMALL } from './constants.ts';
import type { ScreenRequest, TerminalState } from './layer.ts';

export type FrameLayer = {
  subscribe(listener: () => void): () => void;
  state(): Pick<TerminalState, 'tooSmall'>;
  subscribeScreen(listener: (request: ScreenRequest) => void): () => void;
};

export const TerminalFrame = ({ layer, children }: { layer: FrameLayer; children: ReactNode }): ReactNode => {
  const { tooSmall } = useSyncExternalStore(layer.subscribe, layer.state);
  const { write } = useStdout();
  useEffect(
    () =>
      layer.subscribeScreen((request) => {
        if (request.type === 'redraw') write('');
      }),
    [layer, write],
  );
  return (
    <>
      <Box display={tooSmall ? 'none' : 'flex'} flexDirection="column">
        {children}
      </Box>
      {tooSmall ? <Text>{WINDOW_TOO_SMALL}</Text> : null}
    </>
  );
};
