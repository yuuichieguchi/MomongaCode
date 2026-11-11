import { Box, Text, useApp, useStdout } from 'ink';
import { useEffect, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { WINDOW_TOO_SMALL } from './constants.ts';
import type { InkTerminal, ScreenRequest, TerminalState } from './layer.ts';

export type FrameLayer = {
  subscribe(listener: () => void): () => void;
  state(): Pick<TerminalState, 'tooSmall'>;
  subscribeScreen(listener: (request: ScreenRequest) => void): () => void;
  attachInk(ink: InkTerminal): () => void;
};

export const TerminalFrame = ({ layer, children }: { layer: FrameLayer; children: ReactNode }): ReactNode => {
  const { tooSmall } = useSyncExternalStore(layer.subscribe, layer.state);
  const { write } = useStdout();
  const { suspendTerminal } = useApp();
  useEffect(() => layer.attachInk({ suspendTerminal: () => suspendTerminal() }), [layer, suspendTerminal]);
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
