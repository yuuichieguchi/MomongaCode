import { describe, expect, it } from 'vitest';
import { applyAction, emptyEditor, enterOf, expandedText, insertPaste, insertText, pastedLabel, placeCaret, placeText, UNDO_DEPTH, withHistory } from '../src/tui/editor.ts';
import type { EditorAction, EditorState } from '../src/tui/editor.ts';

const typed = (text: string, state: EditorState = emptyEditor()): EditorState => Array.from(text).reduce((current, character) => insertText(current, character), state);

const act = (state: EditorState, ...actions: EditorAction[]): EditorState => actions.reduce(applyAction, state);

describe('word movement and deletion', () => {
  it('moves by word in both directions', () => {
    const state = typed('alpha beta  gamma');
    const back = act(state, 'editor.wordLeft');
    expect(back.cursor).toBe(12);
    expect(act(back, 'editor.wordLeft').cursor).toBe(6);
    expect(act(back, 'editor.wordLeft', 'editor.wordLeft', 'editor.wordLeft').cursor).toBe(0);
    expect(act(placeCaret(state, 0), 'editor.wordRight').cursor).toBe(5);
    expect(act(placeCaret(state, 5), 'editor.wordRight').cursor).toBe(10);
    expect(act(state, 'editor.wordRight').cursor).toBe(17);
  });

  it('deletes the word before and after the caret', () => {
    expect(act(typed('alpha beta'), 'editor.killWordBefore').text).toBe('alpha ');
    expect(act(placeCaret(typed('alpha beta'), 0), 'editor.killWordAfter').text).toBe(' beta');
  });

  it('deletes forward by grapheme', () => {
    expect(act(placeCaret(typed('a😀b'), 1), 'editor.deleteAfter').text).toBe('ab');
    expect(act(typed('ab'), 'editor.deleteAfter').text).toBe('ab');
  });
});

describe('the one slot of deleted text', () => {
  it.each<[EditorAction, number, string, string]>([
    ['editor.killLineStart', 5, ' world', 'hello'],
    ['editor.killLineEnd', 5, 'hello', ' world'],
    ['editor.killWordBefore', 11, 'hello ', 'world'],
    ['editor.killWordAfter', 0, ' world', 'hello'],
  ])('%s keeps what it deleted and ctrl+y inserts it', (action, caret, left, slot) => {
    const state = act(placeCaret(typed('hello world'), caret), action);
    expect(state.text).toBe(left);
    expect(state.killed).toBe(slot);
    const end = act(state, 'editor.lineEnd', 'editor.yank');
    expect(end.text).toBe(`${left}${slot}`);
  });

  it('holds one text: a later deletion replaces the earlier one', () => {
    const state = act(typed('one two'), 'editor.killWordBefore', 'editor.killWordBefore');
    expect(state.killed).toBe('one ');
  });

  it('inserts nothing when nothing was deleted', () => {
    expect(act(typed('abc'), 'editor.yank').text).toBe('abc');
  });
});

describe('undo', () => {
  it('takes consecutive typing without caret movement back as one step', () => {
    const state = typed('hello');
    expect(act(state, 'editor.undo').text).toBe('');
  });

  it('starts a new step after a caret movement', () => {
    const state = typed('def', act(typed('abc'), 'editor.lineStart'));
    expect(state.text).toBe('defabc');
    const once = act(state, 'editor.undo');
    expect(once.text).toBe('abc');
    expect(act(once, 'editor.undo').text).toBe('');
  });

  it('takes back a deletion, a newline and a paste one at a time', () => {
    const state = insertPaste(act(typed('abc'), 'editor.killLineStart', 'prompt.newline'), 'xy');
    expect(state.text).toBe('\nxy');
    const steps = [act(state, 'editor.undo'), act(state, 'editor.undo', 'editor.undo'), act(state, 'editor.undo', 'editor.undo', 'editor.undo')];
    expect(steps.map((step) => step.text)).toEqual(['\n', '', 'abc']);
  });

  it(`keeps at most ${UNDO_DEPTH} steps`, () => {
    let state = emptyEditor();
    for (let index = 0; index < UNDO_DEPTH + 20; index += 1) state = act(insertText(state, 'x'), 'editor.lineEnd');
    expect(state.undo).toHaveLength(UNDO_DEPTH);
    for (let index = 0; index < UNDO_DEPTH + 20; index += 1) state = act(state, 'editor.undo');
    expect(state.text).toBe('x'.repeat(20));
  });

  it('does nothing with no step left', () => {
    expect(act(emptyEditor(), 'editor.undo').text).toBe('');
  });
});

describe('pastes', () => {
  const four = 'a\nb\nc\nd';

  it('inserts a paste of at most 3 lines and 800 characters as text, with its line ends normalised', () => {
    expect(insertPaste(emptyEditor(), 'one\r\ntwo\rthree').text).toBe('one\ntwo\nthree');
    expect(insertPaste(emptyEditor(), 'x'.repeat(800)).text).toBe('x'.repeat(800));
  });

  it('shows a paste of more than 3 lines as one span and expands it on submit', () => {
    const state = insertPaste(typed('see '), four);
    expect(state.text).toBe('see [Pasted text #1 +4 lines]');
    expect(expandedText(state)).toBe(`see ${four}`);
    const outcome = enterOf(state);
    expect(outcome).toMatchObject({ kind: 'submit', text: `see ${four}` });
    expect(outcome.kind === 'submit' ? outcome.state.history : []).toEqual([`see ${four}`]);
  });

  it('shows a paste of more than 800 characters as one span', () => {
    const long = 'y'.repeat(801);
    const state = insertPaste(emptyEditor(), long);
    expect(state.text).toBe(pastedLabel(1, 1));
    expect(expandedText(state)).toBe(long);
  });

  it('numbers the spans and expands each to its own text', () => {
    const state = insertPaste(typed(' and ', insertPaste(emptyEditor(), four)), 'e\nf\ng\nh\ni');
    expect(state.text).toBe('[Pasted text #1 +4 lines] and [Pasted text #2 +5 lines]');
    expect(expandedText(state)).toBe(`${four} and e\nf\ng\nh\ni`);
  });

  it('removes a span whole with backspace and with delete, and steps over it as one unit', () => {
    const state = insertPaste(typed('ab'), four);
    expect(act(state, 'editor.deleteBefore').text).toBe('ab');
    expect(act(state, 'editor.left').cursor).toBe(2);
    expect(act(state, 'editor.left', 'editor.right').cursor).toBe(state.text.length);
    expect(act(state, 'editor.left', 'editor.deleteAfter').text).toBe('ab');
    expect(placeCaret(state, 5).cursor).toBe(state.text.length);
  });
});

describe('enter', () => {
  it('turns a backslash before the caret into a new line', () => {
    const outcome = enterOf(typed('one\\'));
    expect(outcome).toMatchObject({ kind: 'newline', state: { text: 'one\n', cursor: 4 } });
  });

  it('does not submit a blank text', () => {
    expect(enterOf(typed('  ')).kind).toBe('blank');
  });

  it('does not add a line equal to the previous entry to the history', () => {
    const outcome = enterOf(typed('same', emptyEditor(['same'])));
    expect(outcome.kind === 'submit' ? outcome.state.history : []).toEqual(['same']);
  });
});

describe('placing text', () => {
  it('replaces the text, puts the caret at its end and can be undone', () => {
    const state = placeText(typed('draft'), '/help ');
    expect(state).toMatchObject({ text: '/help ', cursor: 6 });
    expect(act(state, 'editor.undo').text).toBe('draft');
  });

  it('keeps the draft when the history arrives', () => {
    const state = withHistory(typed('typed early'), ['older']);
    expect(state.text).toBe('typed early');
    expect(act(placeCaret(state, 0), 'editor.up').text).toBe('older');
    expect(act(placeCaret(state, 0), 'editor.up', 'editor.down').text).toBe('typed early');
  });
});
