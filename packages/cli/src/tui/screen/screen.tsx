import { Box, measureElement } from 'ink';
import type { DOMElement } from 'ink';
import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
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
  panelRows: number | undefined;
  onPanelRows(rows: number | undefined): void;
};

type MeasuredPanel = { node: ReactNode; rows: number };

function Region({ rows, children }: { rows: number; children: ReactNode }) {
  if (rows === 0) return null;
  return (
    <Box height={rows} flexShrink={0} flexDirection="column" overflow="hidden">
      {children}
    </Box>
  );
}

export function Screen({ view, columns, rows, allocation, regions, panel, panelRows, onPanelRows }: ScreenProps) {
  const measuring = useRef<DOMElement>(null);
  const [measured, setMeasured] = useState<MeasuredPanel | undefined>(undefined);
  const fullscreen = view === 'fullscreen';
  useLayoutEffect(() => {
    const height = fullscreen && panel !== undefined && measuring.current !== null ? measureElement(measuring.current).height : undefined;
    onPanelRows(height);
    if (height === undefined) {
      if (measured !== undefined) setMeasured(undefined);
    } else if (measured?.node !== panel || measured?.rows !== height) setMeasured({ node: panel, rows: height });
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
      <Region rows={allocation.viewport}>{regions.transcript}</Region>
      <Region rows={allocation.menu}>{regions.menu}</Region>
      <Region rows={allocation.waiting}>{regions.waiting}</Region>
      <Region rows={allocation.lines}>{regions.lines}</Region>
      <Region rows={allocation.input}>{panel !== undefined && panelRows !== undefined && measured !== undefined ? measured.node : regions.input}</Region>
      <Region rows={allocation.footer}>{regions.footer}</Region>
      <Region rows={allocation.subagents}>{regions.subagents}</Region>
      {panel !== undefined ? (
        <Box height={rows} flexShrink={0} flexDirection="column" overflow="hidden">
          <Box ref={measuring} flexDirection="column" flexShrink={0} width={columns}>
            {panel}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
