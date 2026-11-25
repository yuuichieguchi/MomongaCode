import { Box, Text, useCursor } from 'ink';
import { characterEndAfter } from '../editor.ts';
import type { EditorState } from '../editor.ts';
import { INPUT_BOX_FRAME_ROWS } from './constants.ts';
import { borderOf, styleOf } from './theme.ts';
import { displayWidth, inertText, segmentsOf } from './wrap.ts';

const FIRST_PREFIX = '> ';
const REST_PREFIX = '  ';
const BOX_CHROME_COLUMNS = 4;
const BOX_LEFT_COLUMNS = BOX_CHROME_COLUMNS / 2;
const BOX_TOP_ROWS = INPUT_BOX_FRAME_ROWS / 2;
const CURSOR_COLUMNS = 1;

export type InputRow = { start: number; end: number; text: string; drawn: string };

export type InputLayout = { rows: readonly InputRow[]; caretRow: number; caretCol: number };

const textColumns = (columns: number): number => Math.max(1, columns - BOX_CHROME_COLUMNS - FIRST_PREFIX.length - CURSOR_COLUMNS);

type DrawnCell = { index: number; drawn: string; width: number };

const drawnCellsOf = (line: string): DrawnCell[] =>
  segmentsOf(line).map(({ segment, index }) => {
    const drawn = inertText(segment);
    return { index, drawn, width: displayWidth(drawn) };
  });

const rowsOfLine = (line: string, offset: number, width: number): InputRow[] => {
  const rows: InputRow[] = [];
  let start = 0;
  let used = 0;
  let drawn = '';
  for (const cell of drawnCellsOf(line)) {
    if (used + cell.width > width && cell.index > start) {
      rows.push({ start: offset + start, end: offset + cell.index, text: line.slice(start, cell.index), drawn });
      start = cell.index;
      used = 0;
      drawn = '';
    }
    used += cell.width;
    drawn += cell.drawn;
  }
  rows.push({ start: offset + start, end: offset + line.length, text: line.slice(start), drawn });
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
  return { rows, caretRow, caretCol: row === undefined ? 0 : displayWidth(inertText(text.slice(row.start, cursor))) };
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
  for (const { index, width } of drawnCellsOf(row.text)) {
    if (cells + width > wanted) return row.start + index;
    cells += width;
  }
  return row.end;
};

const HIDDEN_MARK = '•';

const caretPlace = (text: string, cursor: number, hidden: boolean): { text: string; cursor: number } => {
  if (!hidden) return { text, cursor };
  const marks = (part: string): string => HIDDEN_MARK.repeat(segmentsOf(part).length);
  return { text: marks(text), cursor: marks(text.slice(0, cursor)).length };
};

export type EditorViewProps = { editor: EditorState; columns: number; rows: number | undefined; hidden: boolean; framed: boolean };

/** Compute the exact rendered row height of an EditorView without measuring after commit. */
export const editorViewRows = (editor: EditorState, columns: number, rows: number | undefined, hidden: boolean, framed: boolean): number => {
  const shown = caretPlace(editor.text, editor.cursor, hidden);
  const layout = layoutInput(shown.text, shown.cursor, columns);
  const visible = rows ?? layout.rows.length;
  const first = windowTopOf(layout, visible);
  const drawn = Math.min(visible, Math.max(0, layout.rows.length - first));
  return drawn + (framed ? INPUT_BOX_FRAME_ROWS : 0);
};

export function EditorView({ editor, columns, rows, hidden, framed }: EditorViewProps) {
  const shown = caretPlace(editor.text, editor.cursor, hidden);
  const layout = layoutInput(shown.text, shown.cursor, columns);
  const visible = rows ?? layout.rows.length;
  const first = windowTopOf(layout, visible);
  return (
    <Box flexDirection="column" {...(framed ? { borderStyle: 'round' as const, ...borderOf('border'), paddingX: 1 } : {})}>
      {layout.rows.slice(first, first + visible).map((row, offset) => {
        const index = first + offset;
        const prefix = index === 0 ? FIRST_PREFIX : REST_PREFIX;
        if (index !== layout.caretRow) return <Text key={index}>{`${prefix}${row.drawn}`}</Text>;
        const caret = shown.cursor - row.start;
        const atCaret = row.text.slice(caret, characterEndAfter(row.text, caret));
        return (
          <Text key={index}>
            {prefix}
            {inertText(row.text.slice(0, caret))}
            <Text inverse>{atCaret === '' ? ' ' : inertText(atCaret)}</Text>
            {inertText(row.text.slice(caret + atCaret.length))}
          </Text>
        );
      })}
    </Box>
  );
}

export const CHAT_MARK = '>';

export type InputBoxProps = { editor: EditorState; columns: number; rows: number | undefined; top: number; framed: boolean; mark: string; inactiveHint?: string | undefined };

export function InputBox({ editor, columns, rows, top, framed, mark, inactiveHint }: InputBoxProps) {
  const { setCursorPosition } = useCursor();
  const layout = layoutInput(editor.text, editor.cursor, columns);
  const visible = rows ?? layout.rows.length;
  const first = windowTopOf(layout, visible);
  const inactive = inactiveHint !== undefined;
  setCursorPosition(
    inactive
      ? undefined
      : { x: (framed ? BOX_LEFT_COLUMNS : 0) + FIRST_PREFIX.length + layout.caretCol, y: top + (framed ? BOX_TOP_ROWS : 0) + layout.caretRow - first },
  );
  const placeholder = inactive && editor.text === '' ? `${mark} ${inactiveHint}` : undefined;
  return (
    <Box flexDirection="column" {...(framed ? { borderStyle: 'round' as const, ...borderOf('border'), paddingX: 1 } : {})}>
      {layout.rows.slice(first, first + visible).map((row, index) => (
        <Text key={first + index} {...(inactive ? styleOf(['dim']) : {})} wrap="truncate">
          {placeholder !== undefined && first + index === 0 ? placeholder : `${first + index === 0 ? `${mark} ` : REST_PREFIX}${row.drawn}`}
        </Text>
      ))}
    </Box>
  );
}

export const KEPT_DRAFT_LABEL = 'your input, kept while this is open: ';

export const keptDraftLine = (text: string): string | undefined => {
  if (text === '') return undefined;
  const [first = ''] = text.split('\n');
  return `${KEPT_DRAFT_LABEL}${inertText(first)}${text.includes('\n') ? ' …' : ''}`;
};
