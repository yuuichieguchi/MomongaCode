import { Box, Text, useBoxMetrics, useCursor } from 'ink';
import type { DOMElement } from 'ink';
import { useRef } from 'react';
import { characterEndAfter } from '../editor.ts';
import type { EditorState } from '../editor.ts';
import { currentA11y } from './a11y.ts';
import { INPUT_BOX_FRAME_ROWS } from './constants.ts';
import { borderOf } from './theme.ts';
import { displayWidth, segmentsOf } from './wrap.ts';

const FIRST_PREFIX = '> ';
const REST_PREFIX = '  ';
const BOX_CHROME_COLUMNS = 4;
const BOX_LEFT_COLUMNS = BOX_CHROME_COLUMNS / 2;
const BOX_TOP_ROWS = INPUT_BOX_FRAME_ROWS / 2;
const CURSOR_COLUMNS = 1;

export type InputRow = { start: number; end: number; text: string };

export type InputLayout = { rows: readonly InputRow[]; caretRow: number; caretCol: number };

const textColumns = (columns: number): number => Math.max(1, columns - BOX_CHROME_COLUMNS - FIRST_PREFIX.length - CURSOR_COLUMNS);

const rowsOfLine = (line: string, offset: number, width: number): InputRow[] => {
  const rows: InputRow[] = [];
  let start = 0;
  let used = 0;
  for (const { index, width: cells } of segmentsOf(line)) {
    if (used + cells > width && index > start) {
      rows.push({ start: offset + start, end: offset + index, text: line.slice(start, index) });
      start = index;
      used = 0;
    }
    used += cells;
  }
  rows.push({ start: offset + start, end: offset + line.length, text: line.slice(start) });
  return rows;
};

export const layoutInput = (text: string, cursor: number, columns: number): InputLayout => {
  const width = textColumns(columns);
  const rows: InputRow[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    rows.push(...rowsOfLine(line, offset, width));
    offset += line.length + 1;
  }
  const caretRow = rows.findLastIndex((row) => row.start <= cursor && cursor <= row.end);
  const row = rows[caretRow];
  return { rows, caretRow, caretCol: row === undefined ? 0 : displayWidth(text.slice(row.start, cursor)) };
};

export const inputRowsOf = (editor: EditorState, columns: number): number => layoutInput(editor.text, editor.cursor, columns).rows.length;

export const inputBoxRows = (contentRows: number): number => contentRows + INPUT_BOX_FRAME_ROWS;

export const inputContentRows = (boxRows: number): number => Math.max(1, boxRows - INPUT_BOX_FRAME_ROWS);

const windowTopOf = (layout: InputLayout, visible: number): number => Math.max(0, layout.caretRow - visible + 1);

export const inputOffsetAt = (editor: EditorState, columns: number, visible: number, boxRow: number, screenCol: number): number | undefined => {
  const layout = layoutInput(editor.text, editor.cursor, columns);
  const row = layout.rows[windowTopOf(layout, visible) + boxRow - BOX_TOP_ROWS];
  if (row === undefined) return undefined;
  const wanted = screenCol - 1 - BOX_LEFT_COLUMNS - FIRST_PREFIX.length;
  let cells = 0;
  for (const { index, width } of segmentsOf(row.text)) {
    if (cells + width > wanted) return row.start + index;
    cells += width;
  }
  return row.end;
};

const CARET_OPEN = '\u0000';
const CARET_CLOSE = '\u0001';

export function PanelInputBox({ editor }: { editor: EditorState }) {
  const before = editor.text.slice(0, editor.cursor);
  const atCaret = editor.text.slice(editor.cursor, characterEndAfter(editor.text, editor.cursor));
  const blank = atCaret === '' || atCaret === '\n';
  const after = editor.text.slice(editor.cursor + (blank ? 0 : atCaret.length));
  const lines = `${before}${CARET_OPEN}${blank ? ' ' : atCaret}${CARET_CLOSE}${after}`.split('\n');
  return (
    <Box flexDirection="column" {...(currentA11y().screenReader ? {} : { borderStyle: 'round' as const, ...borderOf('border'), paddingX: 1 })}>
      {lines.map((line, index) => {
        const open = line.indexOf(CARET_OPEN);
        const close = line.indexOf(CARET_CLOSE);
        const prefix = index === 0 ? FIRST_PREFIX : REST_PREFIX;
        if (open < 0 || close < 0) return <Text key={index}>{`${prefix}${line}`}</Text>;
        return (
          <Text key={index}>
            {prefix}
            {line.slice(0, open)}
            <Text inverse>{line.slice(open + 1, close)}</Text>
            {line.slice(close + 1)}
          </Text>
        );
      })}
    </Box>
  );
}

export type InputBoxProps = { editor: EditorState; columns: number; rows: number | undefined; top: number | undefined; framed: boolean };

export function InputBox({ editor, columns, rows, top, framed }: InputBoxProps) {
  const box = useRef<DOMElement>(null);
  const measured = useBoxMetrics(box);
  const { setCursorPosition } = useCursor();
  const layout = layoutInput(editor.text, editor.cursor, columns);
  const visible = rows ?? layout.rows.length;
  const first = windowTopOf(layout, visible);
  setCursorPosition({ x: (framed ? BOX_LEFT_COLUMNS : 0) + FIRST_PREFIX.length + layout.caretCol, y: (top ?? measured.top) + (framed ? BOX_TOP_ROWS : 0) + layout.caretRow - first });
  return (
    <Box ref={box} flexDirection="column" {...(framed ? { borderStyle: 'round' as const, ...borderOf('border'), paddingX: 1 } : {})}>
      {layout.rows.slice(first, first + visible).map((row, index) => (
        <Text key={first + index} wrap="truncate">{`${first + index === 0 ? FIRST_PREFIX : REST_PREFIX}${row.text}`}</Text>
      ))}
    </Box>
  );
}
