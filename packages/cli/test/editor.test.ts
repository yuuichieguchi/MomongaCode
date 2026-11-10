import { describe, expect, it } from 'vitest';
import type { Key } from 'ink';
import { applyKeyEvent, emptyEditor } from '../src/tui/editor.ts';
import type { EditorState } from '../src/tui/editor.ts';
import { DEFAULT_KEY_TABLE } from '../src/tui/keys/table.ts';
import { keyEventOf } from './tui/screen-fakes.ts';

type KeyPress = Partial<Key> & { input: string };

const applyKey = (state: EditorState, key: KeyPress) => applyKeyEvent(state, keyEventOf(key.input, key), DEFAULT_KEY_TABLE);

const press = (state: EditorState, ...keys: (string | KeyPress)[]): { state: EditorState; submitted: string[] } => {
  let current = state;
  const submitted: string[] = [];
  for (const key of keys) {
    const outcome = applyKey(current, typeof key === 'string' ? { input: key } : key);
    current = outcome.state;
    if (outcome.submit !== undefined) submitted.push(outcome.submit);
  }
  return { state: current, submitted };
};

const ENTER: KeyPress = { input: '', return: true };

describe('editor typing', () => {
  it('inserts characters at the cursor and moves it', () => {
    const { state } = press(emptyEditor(), 'abc', { input: '', leftArrow: true }, 'X');
    expect(state.text).toBe('abXc');
    expect(state.cursor).toBe(3);
  });

  it('deletes before the caret with backspace and after it with delete', () => {
    expect(press(emptyEditor(), 'abc', { input: '', backspace: true }).state.text).toBe('ab');
    expect(press(emptyEditor(), 'abc', { input: '', delete: true }).state.text).toBe('abc');
    expect(press(emptyEditor(), 'abc', { input: '', leftArrow: true }, { input: '', delete: true }).state.text).toBe('ab');
  });

  it('moves and deletes by whole characters, so an emoji or a joined emoji sequence is never split into surrogate halves', () => {
    const family = '👨‍👩‍👧';
    expect(press(emptyEditor(), 'a😀', { input: '', backspace: true }).state.text).toBe('a');
    expect(press(emptyEditor(), `a${family}`, { input: '', backspace: true }).state.text).toBe('a');
    expect(press(emptyEditor(), 'a😀b', { input: '', leftArrow: true }, { input: '', leftArrow: true }).state.cursor).toBe(1);
    expect(press(emptyEditor(), 'a😀b', { input: '', home: true }, { input: '', rightArrow: true }, { input: '', rightArrow: true }).state.cursor).toBe(3);
    const insertedBeforeEmoji = press(emptyEditor(), '😀', { input: '', leftArrow: true }, 'x').state;
    expect(insertedBeforeEmoji.text).toBe('x😀');
    expect(press(emptyEditor(), 'é', { input: '', backspace: true }).state.text).toBe('');
  });

  it('ignores backspace at the start and meta-modified input', () => {
    expect(press(emptyEditor(), { input: '', backspace: true }).state.text).toBe('');
    expect(press(emptyEditor(), { input: 'x', meta: true }).state.text).toBe('');
  });

  it('inserts a pasted block with its newlines normalised', () => {
    expect(press(emptyEditor(), 'one\r\ntwo\rthree\nfour').state.text).toBe('one\ntwo\nthree\nfour');
  });

  it('supports ctrl shortcuts for line start, line end, kill to the start and to the end of this line only', () => {
    const typed = press(emptyEditor(), 'hello world').state;
    expect(press(typed, { input: 'a', ctrl: true }).state.cursor).toBe(0);
    expect(press(typed, { input: 'a', ctrl: true }, { input: 'e', ctrl: true }).state.cursor).toBe(11);
    expect(press(typed, { input: 'a', ctrl: true }, { input: '', rightArrow: true }, { input: 'k', ctrl: true }).state.text).toBe('h');
    expect(press(typed, { input: 'u', ctrl: true }).state.text).toBe('');
    const lines = press(emptyEditor(), 'one\ntwo\nthree', { input: '', upArrow: true }).state;
    expect(lines.cursor).toBe(7);
    expect(press(lines, { input: 'u', ctrl: true }).state.text).toBe('one\n\nthree');
    expect(press(lines, { input: '', leftArrow: true }, { input: 'k', ctrl: true }).state.text).toBe('one\ntw\nthree');
  });
});

describe('editor submission and lines', () => {
  it('submits the text on enter and clears the buffer', () => {
    const { state, submitted } = press(emptyEditor(), 'hello', ENTER);
    expect(submitted).toEqual(['hello']);
    expect(state.text).toBe('');
  });

  it('does not submit a blank message', () => {
    expect(press(emptyEditor(), '   ', ENTER).submitted).toEqual([]);
  });

  it('turns backslash enter into a new line without the backslash', () => {
    const { state, submitted } = press(emptyEditor(), 'one\\', ENTER, 'two');
    expect(submitted).toEqual([]);
    expect(state.text).toBe('one\ntwo');
  });

  it('turns shift+enter, meta+enter and ctrl+j into a new line', () => {
    expect(press(emptyEditor(), 'a', { input: '', return: true, shift: true }, 'b').state.text).toBe('a\nb');
    expect(press(emptyEditor(), 'a', { input: '', return: true, meta: true }, 'b').state.text).toBe('a\nb');
    expect(press(emptyEditor(), 'a', { input: 'j', ctrl: true }, 'b').state.text).toBe('a\nb');
  });

  it('moves between lines with the arrow keys keeping the column', () => {
    const typed = press(emptyEditor(), 'abc', { input: 'j', ctrl: true }, 'de').state;
    const up = press(typed, { input: '', upArrow: true }).state;
    expect(up.cursor).toBe(2);
    expect(press(up, { input: '', downArrow: true }).state.cursor).toBe(6);
  });
});

describe('editor history', () => {
  const withHistory = press(emptyEditor(), 'first', ENTER, 'second', ENTER, 'draft').state;

  it('recalls earlier messages with up and walks back to the draft with down', () => {
    const up1 = press(withHistory, { input: '', upArrow: true }).state;
    expect(up1.text).toBe('second');
    const up2 = press(up1, { input: '', upArrow: true }).state;
    expect(up2.text).toBe('first');
    expect(press(up2, { input: '', upArrow: true }).state.text).toBe('first');
    const down = press(up2, { input: '', downArrow: true }, { input: '', downArrow: true }).state;
    expect(down.text).toBe('draft');
  });

  it('does not store a repeated message twice', () => {
    expect(press(emptyEditor(), 'same', ENTER, 'same', ENTER).state.history).toEqual(['same']);
  });

  it('moves the cursor inside a multi-line message before leaving it for history', () => {
    const multi = press(emptyEditor(), 'x', ENTER).state;
    const recalled = press({ ...multi, history: ['one\ntwo'] }, { input: '', upArrow: true }).state;
    expect(recalled.text).toBe('one\ntwo');
    expect(press(recalled, { input: '', upArrow: true }).state.text).toBe('one\ntwo');
    expect(press(recalled, { input: '', upArrow: true }).state.cursor).toBeLessThan(recalled.cursor);
  });
});
