import { Box, Text } from 'ink';
import { escapeTerminalLine } from '@momonga/protocol';
import { PASTE_LABEL } from '../plan/sign-in.ts';
import type { EditorState } from './editor.ts';
import { joinHint } from './select.tsx';
import type { SelectRow, SelectSpec } from './select.tsx';

export type PickRow = SelectRow;

export type PickRequest = Pick<SelectSpec, 'title' | 'lines' | 'rows' | 'confirm'> & Partial<Pick<SelectSpec, 'initial' | 'decideOn' | 'escape' | 'filter'>> & { readonly onHighlight?: (index: number) => void };

const FILTER_FROM_ROWS = 10;

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
  delivered(): void;
  loading(title: string): void;
};

const WAITING_HINT = joinHint(['enter submits the pasted URL', 'ctrl+y copies the sign-in URL', 'esc cancels']);

const TEXT_HINT = joinHint(['enter to confirm', 'esc: go back']);

export type PanelOverlay = Exclude<Overlay, { kind: 'pick' }>;

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

export function OverlayView({ overlay, editor }: { overlay: PanelOverlay; editor: EditorState }) {
  switch (overlay.kind) {
    case 'text':
      return (
        <Box flexDirection="column">
          <Text bold>{escapeTerminalLine(overlay.request.title)}</Text>
          {(overlay.request.lines ?? []).map((line, index) => (
            <Text key={index}>{escapeTerminalLine(line)}</Text>
          ))}
          <Text>{`> ${escapeTerminalLine(editor.text)}`}</Text>
          {overlay.error === undefined ? null : <Text color="red">{escapeTerminalLine(overlay.error)}</Text>}
          <Text dimColor>{TEXT_HINT}</Text>
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
