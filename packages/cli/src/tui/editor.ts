export type PastedSpan = { readonly label: string; readonly text: string };

type Snapshot = { readonly text: string; readonly cursor: number };

export type EditorState = {
  text: string;
  cursor: number;
  history: readonly string[];
  historyIndex: number | undefined;
  draft: string;
  killed: string | undefined;
  pastes: readonly PastedSpan[];
  pasteCount: number;
  undo: readonly Snapshot[];
  typing: boolean;
};

export type KeyPress = {
  input: string;
  return?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  backspace?: boolean;
  delete?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  home?: boolean;
  end?: boolean;
};

export type EditorOutcome = { state: EditorState; submit?: string };

export const EDITOR_ACTIONS = [
  'prompt.newline',
  'editor.deleteBefore',
  'editor.deleteAfter',
  'editor.lineStart',
  'editor.lineEnd',
  'editor.left',
  'editor.right',
  'editor.wordLeft',
  'editor.wordRight',
  'editor.killLineStart',
  'editor.killLineEnd',
  'editor.killWordBefore',
  'editor.killWordAfter',
  'editor.yank',
  'editor.undo',
  'editor.up',
  'editor.down',
] as const;

export type EditorAction = (typeof EDITOR_ACTIONS)[number];

export const isEditorAction = (action: string | undefined): action is EditorAction => EDITOR_ACTIONS.some((known) => known === action);

export const UNDO_DEPTH = 100;
export const PASTE_COLLAPSE_LINES = 3;
export const PASTE_COLLAPSE_CHARACTERS = 800;

export const emptyEditor = (history: readonly string[] = []): EditorState => ({ text: '', cursor: 0, history, historyIndex: undefined, draft: '', killed: undefined, pastes: [], pasteCount: 0, undo: [], typing: false });

const LINE_CONTINUATION = '\\';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const words = new Intl.Segmenter(undefined, { granularity: 'word' });

type Range = { start: number; end: number };

const spansOf = (state: EditorState): Range[] =>
  state.pastes.flatMap(({ label }) => {
    const start = state.text.indexOf(label);
    return start < 0 ? [] : [{ start, end: start + label.length }];
  });

const characterStartBefore = (text: string, cursor: number): number => {
  let start = 0;
  for (const { index } of graphemes.segment(text.slice(0, cursor))) start = index;
  return start;
};

export const characterEndAfter = (text: string, cursor: number): number => {
  for (const { index, segment } of graphemes.segment(text)) if (index >= cursor) return index + segment.length;
  return text.length;
};

const leftOf = (state: EditorState): number => {
  if (state.cursor === 0) return 0;
  return spansOf(state).find((span) => span.end === state.cursor)?.start ?? characterStartBefore(state.text, state.cursor);
};

const rightOf = (state: EditorState): number => spansOf(state).find((span) => span.start === state.cursor)?.end ?? characterEndAfter(state.text, state.cursor);

const wordStartBefore = (text: string, cursor: number): number => {
  let start = 0;
  for (const { index, isWordLike } of words.segment(text.slice(0, cursor))) if (isWordLike === true) start = index;
  return start;
};

const wordEndAfter = (text: string, cursor: number): number => {
  for (const { index, segment, isWordLike } of words.segment(text)) if (isWordLike === true && index + segment.length > cursor) return index + segment.length;
  return text.length;
};

const outsideSpans = (state: EditorState, cursor: number, toward: 'start' | 'end'): number => {
  const span = spansOf(state).find((candidate) => candidate.start < cursor && cursor < candidate.end);
  return span === undefined ? cursor : span[toward];
};

const movedTo = (state: EditorState, cursor: number, toward: 'start' | 'end' = 'end'): EditorState => ({ ...state, cursor: outsideSpans(state, cursor, toward), typing: false });

const remembered = (state: EditorState): readonly Snapshot[] => [...state.undo, { text: state.text, cursor: state.cursor }].slice(-UNDO_DEPTH);

const edited = (state: EditorState, text: string, cursor: number, typing = false): EditorState => ({
  ...state,
  text,
  cursor,
  historyIndex: undefined,
  undo: typing && state.typing ? state.undo : remembered(state),
  typing,
});

const removed = (state: EditorState, start: number, end: number): EditorState => (start === end ? { ...state, typing: false } : edited(state, state.text.slice(0, start) + state.text.slice(end), start));

const killed = (state: EditorState, start: number, end: number): EditorState => (start === end ? { ...state, typing: false } : { ...removed(state, start, end), killed: state.text.slice(start, end) });

const inserted = (state: EditorState, text: string, typing: boolean): EditorState => edited(state, state.text.slice(0, state.cursor) + text + state.text.slice(state.cursor), state.cursor + text.length, typing);

const lineStart = (text: string, cursor: number): number => text.lastIndexOf('\n', cursor - 1) + 1;

const lineEnd = (text: string, cursor: number): number => {
  const end = text.indexOf('\n', cursor);
  return end < 0 ? text.length : end;
};

const moveVertically = (state: EditorState, direction: -1 | 1): EditorState | undefined => {
  const start = lineStart(state.text, state.cursor);
  const column = state.cursor - start;
  if (direction === -1) {
    if (start === 0) return undefined;
    const previousStart = lineStart(state.text, start - 1);
    return movedTo(state, Math.min(previousStart + column, start - 1));
  }
  const end = lineEnd(state.text, state.cursor);
  if (end >= state.text.length) return undefined;
  const nextStart = end + 1;
  return movedTo(state, Math.min(nextStart + column, lineEnd(state.text, nextStart)));
};

const recalled = (state: EditorState, text: string, historyIndex: number | undefined, draft: string): EditorState => ({ ...state, text, cursor: text.length, historyIndex, draft, typing: false });

const recall = (state: EditorState, direction: -1 | 1): EditorState | undefined => {
  if (state.history.length === 0) return undefined;
  if (direction === -1) {
    const index = state.historyIndex === undefined ? state.history.length - 1 : state.historyIndex - 1;
    const text = state.history[index];
    if (index < 0 || text === undefined) return undefined;
    return recalled(state, text, index, state.historyIndex === undefined ? state.text : state.draft);
  }
  if (state.historyIndex === undefined) return undefined;
  const index = state.historyIndex + 1;
  if (index >= state.history.length) return recalled(state, state.draft, undefined, state.draft);
  const text = state.history[index];
  return text === undefined ? undefined : recalled(state, text, index, state.draft);
};

const normalizeNewlines = (text: string): string => text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');

export const pushHistory = (history: readonly string[], text: string): readonly string[] => (history.at(-1) === text ? history : [...history, text]);

export const insertText = (state: EditorState, text: string): EditorState => (text === '' ? state : inserted(state, normalizeNewlines(text), true));

export const pastedLabel = (number: number, lines: number): string => `[Pasted text #${number} +${lines} lines]`;

export const insertPaste = (state: EditorState, pasted: string): EditorState => {
  const text = normalizeNewlines(pasted);
  if (text === '') return state;
  const lines = text.split('\n').length;
  if (lines <= PASTE_COLLAPSE_LINES && text.length <= PASTE_COLLAPSE_CHARACTERS) return inserted(state, text, false);
  const number = state.pasteCount + 1;
  const label = pastedLabel(number, lines);
  return { ...inserted(state, label, false), pastes: [...state.pastes, { label, text }], pasteCount: number };
};

export const expandedText = (state: EditorState): string => state.pastes.reduce((text, paste) => text.replace(paste.label, () => paste.text), state.text);

export const placeText = (state: EditorState, text: string): EditorState => edited(state, text, text.length);

export const placeCaret = (state: EditorState, cursor: number): EditorState => movedTo(state, Math.max(0, Math.min(cursor, state.text.length)));

export const withHistory = (state: EditorState, history: readonly string[]): EditorState => ({ ...state, history, historyIndex: undefined });

export const applyAction = (state: EditorState, action: EditorAction): EditorState => {
  const { text, cursor } = state;
  switch (action) {
    case 'prompt.newline':
      return inserted(state, '\n', false);
    case 'editor.deleteBefore':
      return removed(state, leftOf(state), cursor);
    case 'editor.deleteAfter':
      return removed(state, cursor, rightOf(state));
    case 'editor.lineStart':
      return movedTo(state, lineStart(text, cursor));
    case 'editor.lineEnd':
      return movedTo(state, lineEnd(text, cursor));
    case 'editor.left':
      return movedTo(state, leftOf(state), 'start');
    case 'editor.right':
      return movedTo(state, rightOf(state));
    case 'editor.wordLeft':
      return movedTo(state, wordStartBefore(text, cursor), 'start');
    case 'editor.wordRight':
      return movedTo(state, wordEndAfter(text, cursor));
    case 'editor.killLineStart':
      return killed(state, lineStart(text, cursor), cursor);
    case 'editor.killLineEnd':
      return killed(state, cursor, lineEnd(text, cursor));
    case 'editor.killWordBefore':
      return killed(state, outsideSpans(state, wordStartBefore(text, cursor), 'start'), cursor);
    case 'editor.killWordAfter':
      return killed(state, cursor, outsideSpans(state, wordEndAfter(text, cursor), 'end'));
    case 'editor.yank':
      return state.killed === undefined ? { ...state, typing: false } : inserted(state, state.killed, false);
    case 'editor.undo': {
      const previous = state.undo.at(-1);
      if (previous === undefined) return { ...state, typing: false };
      return { ...state, ...previous, historyIndex: undefined, undo: state.undo.slice(0, -1), typing: false };
    }
    case 'editor.up':
      return moveVertically(state, -1) ?? recall(state, -1) ?? state;
    case 'editor.down':
      return moveVertically(state, 1) ?? recall(state, 1) ?? state;
  }
};

export type EnterOutcome = { kind: 'newline'; state: EditorState } | { kind: 'blank' } | { kind: 'submit'; state: EditorState; text: string };

export const enterOf = (state: EditorState): EnterOutcome => {
  if (state.text[state.cursor - 1] === LINE_CONTINUATION) return { kind: 'newline', state: inserted({ ...state, text: state.text.slice(0, state.cursor - 1) + state.text.slice(state.cursor), cursor: state.cursor - 1 }, '\n', false) };
  if (state.text.trim() === '') return { kind: 'blank' };
  const text = expandedText(state);
  return { kind: 'submit', state: emptyEditor(pushHistory(state.history, text)), text };
};

const legacyActionOf = (key: KeyPress): EditorAction | undefined => {
  if (key.return === true) return key.shift === true || key.meta === true ? 'prompt.newline' : undefined;
  if (key.ctrl === true) {
    const byLetter: Readonly<Record<string, EditorAction>> = { j: 'prompt.newline', a: 'editor.lineStart', e: 'editor.lineEnd', u: 'editor.killLineStart', k: 'editor.killLineEnd', w: 'editor.killWordBefore', y: 'editor.yank', _: 'editor.undo' };
    return byLetter[key.input];
  }
  if (key.backspace === true) return 'editor.deleteBefore';
  if (key.delete === true) return 'editor.deleteAfter';
  if (key.leftArrow === true) return 'editor.left';
  if (key.rightArrow === true) return 'editor.right';
  if (key.home === true) return 'editor.lineStart';
  if (key.end === true) return 'editor.lineEnd';
  if (key.upArrow === true) return 'editor.up';
  if (key.downArrow === true) return 'editor.down';
  return undefined;
};

export const applyKey = (state: EditorState, key: KeyPress): EditorOutcome => {
  const action = legacyActionOf(key);
  if (action !== undefined) return { state: applyAction(state, action) };
  if (key.return === true) {
    const outcome = enterOf(state);
    if (outcome.kind === 'blank') return { state };
    return outcome.kind === 'newline' ? { state: outcome.state } : { state: outcome.state, submit: outcome.text };
  }
  if (key.ctrl === true || key.meta === true) return { state };
  return { state: insertText(state, key.input) };
};
