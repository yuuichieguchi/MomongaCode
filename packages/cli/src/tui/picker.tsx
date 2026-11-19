import { Box, Text } from 'ink';
import { escapeTerminalLine } from '@momonga/protocol';
import { PASTE_LABEL } from '../plan/sign-in.ts';
import type { EditorState } from './editor.ts';
import { EditorView } from './screen/input-box.tsx';
import type { KeySpec, KeyTable } from './keys/table.ts';
import { styleOf } from './screen/theme.ts';
import { joinHint } from './select.tsx';
import type { SelectRow, SelectSpec } from './select.tsx';

export type PickRow = SelectRow;

export type PickRequest = Pick<SelectSpec, 'title' | 'lines' | 'rows' | 'confirm' | 'alt' | 'stepsLabel'> & Partial<Pick<SelectSpec, 'initial' | 'decideOn' | 'escape' | 'filter'>> & { readonly onHighlight?: (index: number) => void };

const FILTER_FROM_ROWS = 10;
const TEXT_ROWS_AROUND = 2;
const WAITING_ROWS_AROUND = 6;

export const pickerSpec = ({ onHighlight: _onHighlight, ...request }: PickRequest): SelectSpec => ({
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

export type PickChoice = { readonly index: number; readonly alt: boolean; readonly step?: number };

export type CaptureRequest = { readonly title: string; problemOf(spec: KeySpec): string | undefined };

export type CaptureOutcome = { readonly kind: 'key'; readonly spec: KeySpec } | { readonly kind: 'remove' };

export type Overlay =
  | { readonly kind: 'pick'; readonly request: PickRequest; readonly resolve: (choice: PickChoice | undefined) => void }
  | { readonly kind: 'capture'; readonly request: CaptureRequest; readonly problem?: string; readonly resolve: (outcome: CaptureOutcome | undefined) => void }
  | { readonly kind: 'text'; readonly request: TextRequest; readonly error?: string; readonly resolve: (text: string | undefined) => void }
  | WaitingOverlay
  | { readonly kind: 'loading'; readonly title: string; readonly hint: LoadingHint; cancel(): void };

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

export type PanelOverlay = Exclude<Overlay, { kind: 'pick' }>;

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
          {overlay.hint === LOADING_HINTS.none ? null : <Text dimColor>{loadingHint(keys)}</Text>}
        </Box>
      );
    case 'waiting':
      return <WaitingScreen overlay={overlay} editor={editor} keys={keys} room={room} />;
  }
}
