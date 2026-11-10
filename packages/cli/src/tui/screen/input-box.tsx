import { Box, Text } from 'ink';
import { characterEndAfter } from '../editor.ts';
import type { EditorState } from '../editor.ts';
import { INPUT_BOX_FRAME_ROWS } from './constants.ts';
import { displayWidth } from './wrap.ts';

const FIRST_PREFIX = '> ';
const REST_PREFIX = '  ';
const BOX_CHROME_COLUMNS = 4;
const CURSOR_COLUMNS = 1;

export const inputRowsOf = (editor: EditorState, columns: number): number => {
  const inner = Math.max(1, columns - BOX_CHROME_COLUMNS);
  return editor.text.split('\n').reduce((rows, line) => rows + Math.max(1, Math.ceil((FIRST_PREFIX.length + displayWidth(line) + CURSOR_COLUMNS) / inner)), 0);
};

export const inputBoxRows = (contentRows: number): number => contentRows + INPUT_BOX_FRAME_ROWS;

export function InputBox({ editor }: { editor: EditorState }) {
  const before = editor.text.slice(0, editor.cursor);
  const atCursor = editor.text.slice(editor.cursor, characterEndAfter(editor.text, editor.cursor));
  const cursorChar = atCursor === '' || atCursor === '\n' ? ' ' : atCursor;
  const after = editor.text.slice(editor.cursor + (atCursor === '' || atCursor === '\n' ? 0 : atCursor.length));
  const lines = `${before}\u0000${cursorChar}\u0001${after}`.split('\n');
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {lines.map((line, index) => {
        const open = line.indexOf('\u0000');
        const close = line.indexOf('\u0001');
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
