import { Box, measureElement } from 'ink';
import type { DOMElement } from 'ink';
import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { VIEWPORT_ROWS, panelRowsCap } from './layout.ts';
import type { RowAllocation } from './layout.ts';

export type ScreenRegions = {
  transcript: ReactNode;
  menu: ReactNode;
  waiting: ReactNode;
  lines: ReactNode;
  input: ReactNode;
  footer: ReactNode;
  subagents: ReactNode;
};

export type ScreenView = 'fullscreen' | 'scrollback' | 'blank';

export type ScreenProps = {
  view: ScreenView;
  columns: number;
  rows: number;
  allocation: RowAllocation;
  regions: ScreenRegions;
  panel: ReactNode | undefined;
  onPanelRows(rows: number | undefined): void;
};

function Region({ rows, children }: { rows: number; children: ReactNode }) {
  if (rows === 0) return null;
  return (
    <Box height={rows} flexShrink={0} flexDirection="column" overflow="hidden">
      {children}
    </Box>
  );
}

function NewestRows({ children }: { children: ReactNode }) {
  return (
    <Box flexGrow={1} flexShrink={1} flexBasis={0} minHeight={VIEWPORT_ROWS} flexDirection="column" justifyContent="flex-end" overflow="hidden">
      <Box flexShrink={0} flexDirection="column">
        {children}
      </Box>
      <Box flexGrow={1} flexShrink={1} flexBasis={0} />
    </Box>
  );
}

export function Screen({ view, columns, rows, allocation, regions, panel, onPanelRows }: ScreenProps) {
  const measuring = useRef<DOMElement>(null);
  const fullscreen = view === 'fullscreen';
  useLayoutEffect(() => {
    onPanelRows(fullscreen && panel !== undefined && measuring.current !== null ? measureElement(measuring.current).height : undefined);
  });
  if (view === 'blank') return <Box />;
  if (view === 'scrollback') {
    return (
      <Box flexDirection="column">
        {regions.transcript}
        {regions.menu}
        {regions.waiting}
        {regions.lines}
        {panel ?? regions.input}
        {regions.footer}
        {regions.subagents}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" width={columns} height={rows} overflow="hidden">
      {panel === undefined ? <Region rows={allocation.viewport}>{regions.transcript}</Region> : <NewestRows>{regions.transcript}</NewestRows>}
      <Region rows={allocation.menu}>{regions.menu}</Region>
      <Region rows={allocation.waiting}>{regions.waiting}</Region>
      <Region rows={allocation.lines}>{regions.lines}</Region>
      {panel === undefined ? (
        <Region rows={allocation.input}>{regions.input}</Region>
      ) : (
        <Box maxHeight={panelRowsCap(rows)} flexShrink={0} flexDirection="column" overflow="hidden">
          <Box ref={measuring} flexDirection="column" flexShrink={0} width={columns}>
            {panel}
          </Box>
        </Box>
      )}
      <Region rows={allocation.footer}>{regions.footer}</Region>
      <Region rows={allocation.subagents}>{regions.subagents}</Region>
    </Box>
  );
}
