import { USER_SHELL_OUTPUT_BYTES } from '@momonga/protocol';
import type { UserShellRecord } from '@momonga/protocol';
import type { UserShellEnd } from '../client/runtime-client.ts';
import { expandedText, insertText, placeText } from './editor.ts';
import type { EditorState } from './editor.ts';
import type { KeyTable } from './keys/table.ts';
import type { TranscriptStore } from './screen/store.ts';
import { userToolEnded, userToolOutput, userToolStarted } from './transcript.ts';

export const SHELL_MARK = '!';
export const USER_SHELL_TOOL = 'UserShell';

const MARKS = /^!+/;
const HINT_SEPARATOR = ' · ';

export const typedIntoDraft = (state: EditorState, typed: string): EditorState =>
  !state.shell && state.text === '' && typed.startsWith(SHELL_MARK) ? insertText({ ...state, shell: true }, typed.slice(SHELL_MARK.length)) : insertText(state, typed);

export const leftShell = (state: EditorState): EditorState => {
  const text = state.text.replace(MARKS, '');
  return text === state.text ? { ...state, shell: false } : placeText(state, text);
};

export type ShellCommand = { command: string; include: boolean };

export const shellCommandOf = (state: EditorState): ShellCommand | undefined => {
  if (!state.shell) return undefined;
  const text = expandedText(state);
  const include = !text.startsWith(SHELL_MARK);
  const command = text.slice(include ? 0 : SHELL_MARK.length).trim();
  return command === '' ? undefined : { command, include };
};

export const shellHistoryText = ({ command, include }: ShellCommand): string => `${include ? SHELL_MARK : `${SHELL_MARK}${SHELL_MARK}`}${command}`;

export const shellHint = (keys: KeyTable): string =>
  ['! shell: output goes to the model', '!! keeps it out', `${keys.keyHint('shell.run')} runs`, `${keys.keyHint('shell.leave')} leaves`].join(HINT_SEPARATOR);

export const shellTitle = ({ command, include }: ShellCommand): string => `${include ? SHELL_MARK : `${SHELL_MARK}${SHELL_MARK}`} ${command}`;

export const shellLabel = (command: ShellCommand): string => shellTitle(command);

export const refusedText = (reason: string): string => `not run: ${reason}`;

const endedTitle = (record: UserShellRecord): string => {
  const title = shellTitle(record);
  if (record.exitCode === 0) return title;
  return `${title} (${record.exitCode === null ? 'interrupted' : `exit ${record.exitCode}`})`;
};

const idOf = (store: TranscriptStore): string => `user-shell:${store.count()}`;

export type RunningShell = { id: string; command: ShellCommand };

export const shellStarted = (store: TranscriptStore, command: ShellCommand, startedAt: number): RunningShell => {
  const id = idOf(store);
  userToolStarted(store, { id, name: USER_SHELL_TOOL, title: shellTitle(command), startedAt });
  return { id, command };
};

export const shellOutput = (store: TranscriptStore, running: RunningShell, text: string): void => {
  userToolOutput(store, running.id, text, USER_SHELL_OUTPUT_BYTES);
};

export const shellEnded = (store: TranscriptStore, running: RunningShell, end: UserShellEnd, endedAt: number): void => {
  if (end.kind === 'refused') {
    userToolEnded(store, running.id, { status: 'failed', title: shellTitle(running.command), output: refusedText(end.reason), endedAt });
    return;
  }
  userToolEnded(store, running.id, { status: end.record.exitCode === 0 ? 'completed' : 'failed', title: endedTitle(end.record), output: end.record.output, endedAt });
};

export const shellFailed = (store: TranscriptStore, running: RunningShell, endedAt: number): void => {
  userToolEnded(store, running.id, { status: 'unknown', title: shellTitle(running.command), output: undefined, endedAt });
};

export const showShellRecord = (store: TranscriptStore, record: UserShellRecord, at: number): void => {
  const running = shellStarted(store, record, at);
  shellEnded(store, running, { kind: 'exit', record }, at);
};
