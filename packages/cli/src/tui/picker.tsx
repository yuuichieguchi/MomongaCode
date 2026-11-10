import { Box, Text } from 'ink';
import { escapeTerminalLine } from '@momonga/protocol';
import { PASTE_LABEL } from '../plan/sign-in.ts';
import type { EditorState } from './editor.ts';

export type PickRow = { readonly label: string; readonly disabled?: boolean };

export type PickRequest = {
  readonly title?: string;
  readonly lines?: readonly string[];
  readonly rows: readonly PickRow[];
  readonly hint?: string;
  readonly confirm?: (row: PickRow) => string;
};

export type TextRequest = {
  readonly title: string;
  readonly lines?: readonly string[];
  readonly initial?: string;
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

export type Overlay =
  | { readonly kind: 'pick'; readonly request: PickRequest; readonly resolve: (index: number | undefined) => void }
  | { readonly kind: 'text'; readonly request: TextRequest; readonly error?: string; readonly resolve: (text: string | undefined) => void }
  | WaitingOverlay
  | { readonly kind: 'loading'; readonly title: string };

export type OverlayPorts = {
  pick(request: PickRequest): Promise<number | undefined>;
  promptText(request: TextRequest): Promise<string | undefined>;
  waiting(view: WaitingView, handlers: WaitingHandlers): void;
  closeWaiting(): void;
  loading(title: string): void;
};

const PICK_HINT = 'up/down and enter to choose, esc to go back';

const WAITING_HINT = 'enter submits the pasted URL · ctrl+y copies the sign-in URL · esc cancels';

function WaitingScreen({ overlay, editor }: { overlay: WaitingOverlay; editor: EditorState }) {
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
      <Text>{`> ${escapeTerminalLine(editor.text)}`}</Text>
      {overlay.problem === undefined ? null : <Text color="red">{escapeTerminalLine(overlay.problem)}</Text>}
      {overlay.status === undefined ? null : <Text dimColor>{escapeTerminalLine(overlay.status)}</Text>}
      <Text dimColor>{WAITING_HINT}</Text>
    </Box>
  );
}

const rowText = (row: PickRow, index: number, selected: boolean): string => `${selected ? '›' : ' '} ${index + 1}. ${escapeTerminalLine(row.label)}${row.disabled === true ? ' (unavailable)' : ''}`;

export function OverlayView({ overlay, selected, confirming, editor }: { overlay: Overlay; selected: number; confirming: number | undefined; editor: EditorState }) {
  switch (overlay.kind) {
    case 'pick': {
      const { request } = overlay;
      const pending = confirming === undefined ? undefined : request.rows[confirming];
      return (
        <Box flexDirection="column">
          {request.title === undefined ? null : <Text bold>{escapeTerminalLine(request.title)}</Text>}
          {(request.lines ?? []).map((line, index) => (
            <Text key={`line-${index}`}>{escapeTerminalLine(line)}</Text>
          ))}
          {request.rows.map((row, index) => (
            <Text key={`row-${index}`}>{rowText(row, index, index === selected)}</Text>
          ))}
          {pending === undefined || request.confirm === undefined ? null : <Text color="yellow">{escapeTerminalLine(request.confirm(pending))}</Text>}
          <Text dimColor>{request.hint ?? PICK_HINT}</Text>
        </Box>
      );
    }
    case 'text':
      return (
        <Box flexDirection="column">
          <Text bold>{escapeTerminalLine(overlay.request.title)}</Text>
          {(overlay.request.lines ?? []).map((line, index) => (
            <Text key={index}>{escapeTerminalLine(line)}</Text>
          ))}
          <Text>{`> ${escapeTerminalLine(editor.text)}`}</Text>
          {overlay.error === undefined ? null : <Text color="red">{escapeTerminalLine(overlay.error)}</Text>}
          <Text dimColor>enter to confirm, esc to go back</Text>
        </Box>
      );
    case 'loading':
      return (
        <Box flexDirection="column">
          <Text bold>{escapeTerminalLine(overlay.title)}</Text>
          <Text dimColor>reading…</Text>
        </Box>
      );
    case 'waiting':
      return <WaitingScreen overlay={overlay} editor={editor} />;
  }
}
