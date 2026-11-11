import { Box, Text } from 'ink';
import { useEffect, useEffectEvent, useState } from 'react';
import { escapeTerminalBlock } from '@momonga/protocol';
import type { KeyTable } from '../keys/table.ts';
import { joinHint, SELECT_CONTEXTS } from '../select.tsx';
import type { ExternalOpen } from '../external-editor.ts';
import type { TuiStart } from '../tui-start-settings.ts';
import type { ScreenInput } from './input.ts';
import { styleOf } from './theme.ts';

export const REPAIR_TITLE = 'The settings do not load';
export const OPEN_SETTINGS_FILE = 'Open the settings file';
export const NO_SESSION_LINE = 'No session starts until the file loads.';
export const EDITOR_UNSET_LINE = 'Set $VISUAL or $EDITOR to open the settings file from here.';

export type RepairScreenProps = {
  broken: Extract<TuiStart, { kind: 'broken' }>;
  input: Pick<ScreenInput, 'claim'>;
  keys: KeyTable;
  onOpen(): void;
  onQuit(): void;
  note?: string | undefined;
};

const repairHint = (keys: KeyTable, canOpen: boolean): string =>
  joinHint([...(canOpen && keys.keyHint('select.decide') !== '' ? [`${keys.keyHint('select.decide')}: ${OPEN_SETTINGS_FILE.toLowerCase()} in $EDITOR`] : []), ...(keys.keyHint('select.escape') === '' ? [] : [`${keys.keyHint('select.escape')} quits`])]);

export function RepairScreen({ broken, input, keys, onOpen, onQuit, note }: RepairScreenProps) {
  const canOpen = broken.file !== undefined;
  const onKey = useEffectEvent((action: string | undefined): boolean => {
    if (action === 'select.decide' && canOpen) onOpen();
    else if (action === 'select.escape' || action === 'select.interrupt') onQuit();
    return true;
  });
  useEffect(() => input.claim('typing', (event) => event.type === 'key' && onKey(keys.actionOf(SELECT_CONTEXTS, event))), [input, keys]);
  return (
    <Box flexDirection="column">
      <Text bold>{REPAIR_TITLE}</Text>
      <Text {...styleOf(['error'])}>{escapeTerminalBlock(broken.message)}</Text>
      <Text>{NO_SESSION_LINE}</Text>
      {canOpen ? <Text>{`> ${OPEN_SETTINGS_FILE}`}</Text> : null}
      {note === undefined ? null : <Text {...styleOf(['warning'])}>{note}</Text>}
      <Text dimColor>{repairHint(keys, canOpen)}</Text>
    </Box>
  );
}

export type RepairOutcome = { readonly kind: 'loaded'; readonly start: Extract<TuiStart, { kind: 'loaded' }> } | { readonly kind: 'quit' };

export type RepairFlowProps = {
  first: Extract<TuiStart, { kind: 'broken' }>;
  input: Pick<ScreenInput, 'claim'>;
  keys: KeyTable;
  open(file: string): Promise<ExternalOpen>;
  reread(): Promise<TuiStart>;
  done(outcome: RepairOutcome): void;
  failed(error: unknown): void;
};

export function RepairFlow({ first, input, keys, open, reread, done, failed }: RepairFlowProps) {
  const [broken, setBroken] = useState(first);
  const [note, setNote] = useState<string | undefined>(undefined);
  const reopen = async (file: string): Promise<void> => {
    const opened = await open(file);
    setNote(opened.kind === 'unset' ? EDITOR_UNSET_LINE : undefined);
    if (opened.kind === 'unset') return;
    const next = await reread();
    if (next.kind === 'loaded') done({ kind: 'loaded', start: next });
    else setBroken(next);
  };
  return (
    <RepairScreen
      broken={broken}
      note={note}
      input={input}
      keys={keys}
      onOpen={() => {
        if (broken.file !== undefined) reopen(broken.file).catch(failed);
      }}
      onQuit={() => done({ kind: 'quit' })}
    />
  );
}
