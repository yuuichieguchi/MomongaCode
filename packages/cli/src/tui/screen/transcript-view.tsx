import { Box, Text } from 'ink';
import { RowText } from './row-text.tsx';
import { indexRangeOf, selectedColumns } from './selection.ts';
import type { Selection } from './selection.ts';
import { thumbRow } from './viewport.ts';
import type { ViewWindow } from './viewport.ts';
import type { TranscriptHover } from './use-transcript-view.ts';

export const JUMP_TO_BOTTOM = 'jump to bottom';

export const SCROLLBAR_COLUMNS = 1;

const TRACK = '│';
const THUMB = '█';

export type TranscriptViewProps = { window: ViewWindow; height: number; width: number; entries: number; following: boolean; selection: Selection | undefined; hovered: TranscriptHover | undefined };

export function TranscriptView({ window, height, width, entries, following, selection, hovered }: TranscriptViewProps) {
  const scrollable = !(window.atTop && window.atBottom);
  const thumb = scrollable ? thumbRow(window, entries, height) : undefined;
  return (
    <Box flexDirection="column" width={width + SCROLLBAR_COLUMNS} height={height}>
      {Array.from({ length: height }, (_, index) => {
        const visible = window.rows[index];
        const columns = visible === undefined || selection === undefined ? undefined : selectedColumns(selection, visible.entryId, visible.rowIndex);
        const marker = !following && index === height - 1;
        const hover = hovered?.row === index ? hovered : undefined;
        const shownRange = visible === undefined ? undefined : hover !== undefined ? (hover.range ?? indexRangeOf(visible.row, 0, width)) : columns === undefined ? undefined : indexRangeOf(visible.row, columns[0], columns[1]);
        return (
          <Box key={index} height={1} flexShrink={0}>
            <Box width={width} flexShrink={0}>
              {marker ? <Text inverse>{hover === undefined ? JUMP_TO_BOTTOM : JUMP_TO_BOTTOM.padEnd(width)}</Text> : visible === undefined ? <Text> </Text> : <RowText row={visible.row} selected={shownRange} />}
            </Box>
            <Text dimColor>{thumb === undefined ? ' ' : index === thumb ? THUMB : TRACK}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
