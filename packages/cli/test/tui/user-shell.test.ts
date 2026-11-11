import { describe, expect, it } from 'vitest';
import { DEFAULT_KEY_TABLE } from '../../src/tui/keys/table.ts';
import { createTranscriptStore } from '../../src/tui/screen/store.ts';
import { foldReplayedEvent } from '../../src/tui/transcript.ts';
import { emptyEditor, insertPaste, placeText } from '../../src/tui/editor.ts';
import type { EditorState } from '../../src/tui/editor.ts';
import { leftShell, shellCommandOf, shellEnded, shellHint, shellHistoryText, shellOutput, shellStarted, showShellRecord, typedIntoDraft } from '../../src/tui/user-shell.ts';
import { eventOf, plainOf } from './screen-fakes.ts';

const typedInto = (text: string, state: EditorState = emptyEditor()): EditorState => typedIntoDraft(state, text);

describe('the shell mode of a draft (design 5.9)', () => {
  it('is entered only by a ! typed into an empty draft, and is a flag of the draft, not its text', () => {
    const shell = typedInto('!');
    expect(shell).toMatchObject({ shell: true, text: '' });
    expect(typedInto('ls', shell).text).toBe('ls');
    expect(typedInto('!', typedInto('ls')).shell).toBe(false);
    expect(insertPaste(emptyEditor(), '!important')).toMatchObject({ shell: false, text: '!important' });
    expect(placeText(shell, '!ls').shell).toBe(false);
  });

  it('names the command for the model with one mark and kept out with two', () => {
    expect(shellCommandOf(typedInto('!ls -la'))).toEqual({ command: 'ls -la', include: true });
    expect(shellCommandOf(typedInto('!!cat notes.txt'))).toEqual({ command: 'cat notes.txt', include: false });
    expect(shellCommandOf(typedInto('! git status '))).toEqual({ command: 'git status', include: true });
    expect(shellHistoryText({ command: 'cat notes.txt', include: false })).toBe('!!cat notes.txt');
  });

  it('names no command when only the marks are typed, and none for a draft that is not in the mode', () => {
    expect(shellCommandOf(typedInto('!'))).toBeUndefined();
    expect(shellCommandOf(typedInto('!!  '))).toBeUndefined();
    expect(shellCommandOf(insertPaste(emptyEditor(), '!ls'))).toBeUndefined();
  });

  it('becomes a chat draft again without its marks', () => {
    expect(leftShell(typedInto('!!ls'))).toMatchObject({ shell: false, text: 'ls' });
    expect(leftShell(typedInto('!'))).toMatchObject({ shell: false, text: '' });
  });

  it('has the hint row of the design, with the keys of the table', () => {
    expect(shellHint(DEFAULT_KEY_TABLE)).toBe('! shell: output goes to the model · !! keeps it out · enter runs · esc leaves');
  });
});

describe('the entry of a user command in the transcript', () => {
  it('runs with its command, keeps the output that streams in, and ends with the stored output', () => {
    const store = createTranscriptStore();
    const running = shellStarted(store, { command: 'make test', include: true }, 1000);
    expect(plainOf(store).entries).toEqual([{ kind: 'tool', callId: running.id, name: 'UserShell', title: '! make test', toolKind: 'execute', rawInput: undefined, status: 'running', calledAt: 1000, shownAt: 1000 }]);
    expect(store.state().runningTools).toEqual([{ callId: running.id, title: '! make test', startedAt: 1000 }]);

    shellOutput(store, running, 'one\n');
    shellOutput(store, running, 'two\n');
    expect(plainOf(store).entries[0]).toMatchObject({ output: 'one\ntwo\n', tail: { lines: ['one', 'two'], hidden: 0 } });

    shellEnded(store, running, { kind: 'exit', record: { command: 'make test', exitCode: 0, output: 'one\ntwo', include: true } }, 4000);
    expect(plainOf(store).entries[0]).toMatchObject({ status: 'completed', title: '! make test', output: 'one\ntwo', shownAt: 4000 });
    expect(store.state().runningTools).toEqual([]);
  });

  it('keeps the last five lines of a long output and counts the rest', () => {
    const store = createTranscriptStore();
    const lines = Array.from({ length: 12 }, (_unused, index) => `line ${index + 1}`);
    showShellRecord(store, { command: 'seq 12', exitCode: 0, output: lines.join('\n'), include: false }, 5);
    expect(plainOf(store).entries[0]).toMatchObject({ title: '!! seq 12', status: 'completed', tail: { lines: lines.slice(-5), hidden: 7 } });
  });

  it('names a failing exit code and an interrupt in the title', () => {
    const store = createTranscriptStore();
    showShellRecord(store, { command: 'make', exitCode: 2, output: 'no rule', include: true }, 5);
    showShellRecord(store, { command: 'sleep 600', exitCode: null, output: '[terminated by SIGTERM]', include: true }, 5);
    expect(plainOf(store).entries.map((entry) => (entry.kind === 'tool' ? `${entry.status} ${entry.title}` : ''))).toEqual(['failed ! make (exit 2)', 'failed ! sleep 600 (interrupted)']);
  });

  it('says why a refused command was not run', () => {
    const store = createTranscriptStore();
    const running = shellStarted(store, { command: 'rm -rf x', include: true }, 1);
    shellEnded(store, running, { kind: 'refused', reason: 'denied by rule Bash(rm:*)' }, 2);
    expect(plainOf(store).entries[0]).toMatchObject({ status: 'failed', title: '! rm -rf x', output: 'not run: denied by rule Bash(rm:*)' });
  });
});

describe('a reopened session', () => {
  it('shows the commands typed before a message above it, both kinds, and the attached files below it', () => {
    const store = createTranscriptStore();
    const prompt = eventOf({
      type: 'user.message',
      text: 'why does it fail',
      shell: [
        { command: 'make test', exitCode: 2, output: 'FAIL', include: true },
        { command: 'cat notes', exitCode: 0, output: 'private', include: false },
      ],
      attachments: [
        { type: 'attached_file', path: 'src/app.tsx', lines: 412 },
        { type: 'attachment_note', path: '.env', shown: '.env: not attached (denied by a rule)' },
      ],
    });
    foldReplayedEvent(store, prompt, 1, (record) => showShellRecord(store, record, 9));
    expect(plainOf(store).entries.map((entry) => (entry.kind === 'tool' ? entry.title : 'text' in entry ? entry.text : entry.kind))).toEqual([
      '! make test (exit 2)',
      '!! cat notes',
      'why does it fail',
      'attached src/app.tsx (412 lines)',
      '.env: not attached (denied by a rule)',
    ]);
  });
});
