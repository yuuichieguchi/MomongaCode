import { Box, Text } from 'ink';
import { escapeTerminalLine } from '@momonga/protocol';
import { PASTE_LABEL } from '../plan/sign-in.ts';
import type { EditorState } from './editor.ts';
import { EditorView, editorViewRows } from './screen/input-box.tsx';
import { wrapText } from './screen/wrap.ts';
import type { KeySpec, KeyTable } from './keys/table.ts';
import { styleOf } from './screen/theme.ts';
import { joinHint } from './select.tsx';
import type { SelectRow, SelectSpec } from './select.tsx';

export type PickRow = SelectRow;

export type PickUpdate = Pick<SelectSpec, 'rows'> & Partial<Pick<SelectSpec, 'lines'>> & { readonly alt?: SelectSpec['alt'] | undefined; readonly highlight: number };

export type PickRequest = Pick<SelectSpec, 'title' | 'lines' | 'rows' | 'confirm' | 'alt'> &
  Partial<Pick<SelectSpec, 'initial' | 'decideOn' | 'escape' | 'filter'>> & { readonly showModelInFooter?: boolean; readonly onHighlight?: (index: number) => void; readonly watch?: (show: (update: PickUpdate) => void) => () => void };

const FILTER_FROM_ROWS = 10;
const TEXT_ROWS_AROUND = 2;
const WAITING_ROWS_AROUND = 6;

export const pickerSpec = ({ showModelInFooter: _showModelInFooter, onHighlight: _onHighlight, watch: _watch, ...request }: PickRequest): SelectSpec => ({
  initial: 0,
  decideOn: 'immediate',
  escape: 'back',
  filter: request.rows.length >= FILTER_FROM_ROWS,
  ...request,
  interrupt: 'back',
});

export type TextRequest = {
  readonly title: string;
  readonly lines?: readonly string[];
  readonly initial?: string;
  readonly hidden?: boolean;
  readonly structured?: boolean;
  validate(text: string): string | undefined;
};

export type WaitingView = { readonly title: string; readonly lines: readonly string[]; readonly url: URL; readonly state: string };

export type WaitingHandlers = { cancel(): void; deliver(text: string): void };

export type WaitingOverlay = {
  readonly kind: 'waiting';
  readonly view: WaitingView;
  readonly handlers: WaitingHandlers;
  readonly delivered: boolean;
  readonly problem?: string;
  readonly status?: string;
};

export type PickChoice = { readonly index: number; readonly alt: boolean };

export type CaptureRequest = { readonly title: string; problemOf(spec: KeySpec): string | undefined };

export type CaptureOutcome = { readonly kind: 'key'; readonly spec: KeySpec } | { readonly kind: 'remove' };

export type Overlay =
  | { readonly kind: 'pick'; readonly request: PickRequest; readonly resolve: (choice: PickChoice | undefined) => void }
  | { readonly kind: 'capture'; readonly request: CaptureRequest; readonly problem?: string; readonly resolve: (outcome: CaptureOutcome | undefined) => void }
  | { readonly kind: 'text'; readonly request: TextRequest; readonly error?: string; readonly resolve: (text: string | undefined) => void }
  | WaitingOverlay
  | LoadingOverlay
  | { readonly kind: 'kept'; readonly shown: KeptScreen; readonly phase?: string };

export type LoadingOverlay = { readonly kind: 'loading'; readonly title: string; readonly line?: string; readonly hint: LoadingHint; cancel(): void };

export type KeptScreen = Exclude<Overlay, { kind: 'kept' }>;

export const LOADING_HINTS = { readingAndCancel: 'readingAndCancel', none: 'none' } as const;

export type LoadingHint = (typeof LOADING_HINTS)[keyof typeof LOADING_HINTS];

export type Loaded<T> = { readonly kind: 'read'; readonly value: T } | { readonly kind: 'cancelled' };

export type OverlayPorts = {
  pick(request: PickRequest): Promise<number | undefined>;
  choose(request: PickRequest): Promise<PickChoice | undefined>;
  captureKey(request: CaptureRequest): Promise<CaptureOutcome | undefined>;
  promptText(request: TextRequest): Promise<string | undefined>;
  waiting(view: WaitingView, handlers: WaitingHandlers): void;
  closeWaiting(): void;
  delivered(): void;
  loading<T>(title: string, read: () => Promise<T>, hint: LoadingHint): Promise<Loaded<T>>;
  read<T>(read: () => Promise<T>): Promise<Loaded<T>>;
  closeScreen(): void;
};

const keyed = (key: string, text: (key: string) => string): string[] => (key === '' ? [] : [text(key)]);

export const waitingHint = (keys: KeyTable): string =>
  joinHint([
    ...keyed(keys.keyHint('select.decide'), (key) => `${key} submits the pasted URL`),
    ...keyed(keys.keyHint('select.copy'), (key) => `${key} copies the sign-in URL`),
    ...keyed(keys.keyHint('select.escape'), (key) => `${key} cancels`),
  ]);

export const textHint = (keys: KeyTable): string => joinHint([...keyed(keys.keyHint('select.decide'), (key) => `${key} to confirm`), ...keyed(keys.keyHint('select.escape'), (key) => `${key}: go back`)]);

export const structuredHint = (keys: KeyTable): string =>
  joinHint([
    ...keyed(keys.keyHint('editor.submitValue'), (key) => `${key} to confirm`),
    ...keyed(keys.keyHint('select.decide'), (key) => `${key}: new line`),
    ...keyed(keys.keyHint('editor.external'), (key) => `${key} edits it in $EDITOR`),
    ...keyed(keys.keyHint('select.escape'), (key) => `${key}: go back`),
  ]);

export const READING_TEXT = 'reading…';

export const loadingHint = (keys: KeyTable): string => joinHint([READING_TEXT, ...keyed(keys.keyHint('select.escape'), (key) => `${key} cancels`)]);

export type PanelOverlay = Exclude<Overlay, { kind: 'pick' | 'kept' }>;

type ViewRoom = { readonly columns: number; readonly rows: number };

const ENTRY_ROWS_MIN = 1;

const entryRows = (room: ViewRoom, around: number): number => Math.max(ENTRY_ROWS_MIN, room.rows - around);

function WaitingScreen({ overlay, editor, keys, room }: { overlay: WaitingOverlay; editor: EditorState; keys: KeyTable; room: ViewRoom }) {
  if (overlay.delivered) {
    return (
      <Box flexDirection="column">
        <Text bold>{escapeTerminalLine(overlay.view.title)}</Text>
        <Text>Finishing the sign-in…</Text>
        <Text dimColor>please wait</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text bold>{escapeTerminalLine(overlay.view.title)}</Text>
      {overlay.view.lines.map((line, index) => (
        <Text key={index}>{escapeTerminalLine(line)}</Text>
      ))}
      <Text> </Text>
      <Text>{PASTE_LABEL}</Text>
      <EditorView editor={editor} columns={room.columns} rows={entryRows(room, overlay.view.lines.length + WAITING_ROWS_AROUND)} hidden={false} framed={false} />
      {overlay.problem === undefined ? null : <Text {...styleOf(['error'])}>{escapeTerminalLine(overlay.problem)}</Text>}
      {overlay.status === undefined ? null : <Text dimColor>{escapeTerminalLine(overlay.status)}</Text>}
      <Text dimColor>{waitingHint(keys)}</Text>
    </Box>
  );
}

function TextScreen({ overlay, editor, keys, room }: { overlay: Extract<Overlay, { kind: 'text' }>; editor: EditorState; keys: KeyTable; room: ViewRoom }) {
  const lines = overlay.request.lines ?? [];
  const around = TEXT_ROWS_AROUND + lines.length + (overlay.error === undefined ? 0 : 1);
  return (
    <Box flexDirection="column">
      <Text bold>{escapeTerminalLine(overlay.request.title)}</Text>
      {lines.map((line, index) => (
        <Text key={index}>{escapeTerminalLine(line)}</Text>
      ))}
      <EditorView editor={editor} columns={room.columns} rows={entryRows(room, around)} hidden={overlay.request.hidden === true} framed={false} />
      {overlay.error === undefined ? null : <Text {...styleOf(['error'])}>{escapeTerminalLine(overlay.error)}</Text>}
      <Text dimColor>{overlay.request.structured === true ? structuredHint(keys) : textHint(keys)}</Text>
    </Box>
  );
}

const wrappedLineCount = (text: string, columns: number): number => wrapText(escapeTerminalLine(text), Math.max(1, columns), { links: false }).length;

/** Compute the exact rendered row height of an OverlayView synchronously. */
export const overlayPanelRows = (overlay: PanelOverlay, editor: EditorState, keys: KeyTable, room: ViewRoom): number => {
  const { columns } = room;
  switch (overlay.kind) {
    case 'capture':
      return wrappedLineCount(overlay.request.title, columns) + (overlay.problem === undefined ? 0 : wrappedLineCount(overlay.problem, columns));
    case 'loading':
      return wrappedLineCount(overlay.title, columns) + (overlay.line === undefined ? 0 : wrappedLineCount(overlay.line, columns)) + (overlay.hint === LOADING_HINTS.none ? 0 : wrappedLineCount(loadingHint(keys), columns));
    case 'text': {
      const lines = overlay.request.lines ?? [];
      const around = TEXT_ROWS_AROUND + lines.length + (overlay.error === undefined ? 0 : 1);
      return (
        wrappedLineCount(overlay.request.title, columns) +
        lines.reduce((sum, line) => sum + wrappedLineCount(line, columns), 0) +
        editorViewRows(editor, columns, entryRows(room, around), overlay.request.hidden === true, false) +
        (overlay.error === undefined ? 0 : wrappedLineCount(overlay.error, columns)) +
        wrappedLineCount(overlay.request.structured === true ? structuredHint(keys) : textHint(keys), columns)
      );
    }
    case 'waiting':
      if (overlay.delivered) return wrappedLineCount(overlay.view.title, columns) + wrappedLineCount('Finishing the sign-in…', columns) + wrappedLineCount('please wait', columns);
      return (
        wrappedLineCount(overlay.view.title, columns) +
        overlay.view.lines.reduce((sum, line) => sum + wrappedLineCount(line, columns), 0) +
        1 +
        wrappedLineCount(PASTE_LABEL, columns) +
        editorViewRows(editor, columns, entryRows(room, overlay.view.lines.length + WAITING_ROWS_AROUND), false, false) +
        (overlay.problem === undefined ? 0 : wrappedLineCount(overlay.problem, columns)) +
        (overlay.status === undefined ? 0 : wrappedLineCount(overlay.status, columns)) +
        wrappedLineCount(waitingHint(keys), columns)
      );
  }
};

export function OverlayView({ overlay, editor, keys, columns, rows }: { overlay: PanelOverlay; editor: EditorState; keys: KeyTable; columns: number; rows: number }) {
  const room = { columns, rows };
  switch (overlay.kind) {
    case 'text':
      return <TextScreen overlay={overlay} editor={editor} keys={keys} room={room} />;
    case 'capture':
      return (
        <Box flexDirection="column">
          <Text bold>{escapeTerminalLine(overlay.request.title)}</Text>
          {overlay.problem === undefined ? null : <Text {...styleOf(['error'])}>{escapeTerminalLine(overlay.problem)}</Text>}
        </Box>
      );
    case 'loading':
      return (
        <Box flexDirection="column">
          <Text bold>{escapeTerminalLine(overlay.title)}</Text>
          {overlay.line === undefined ? null : <Text>{escapeTerminalLine(overlay.line)}</Text>}
          {overlay.hint === LOADING_HINTS.none ? null : <Text dimColor>{loadingHint(keys)}</Text>}
        </Box>
      );
    case 'waiting':
      return <WaitingScreen overlay={overlay} editor={editor} keys={keys} room={room} />;
  }
}
