import type { KeyContext, KeyTable } from './keys/table.ts';
import type { KeyEvent } from './terminal/events.ts';

export type PastedSpan = { readonly start: number; readonly label: string; readonly text: string };

type Snapshot = { readonly text: string; readonly cursor: number; readonly pastes: readonly PastedSpan[] };

export type EditorState = {
  text: string;
  cursor: number;
  history: readonly string[];
  historyIndex: number | undefined;
  draft: string;
  draftPastes: readonly PastedSpan[];
  killed: string | undefined;
  pastes: readonly PastedSpan[];
  pasteCount: number;
  undo: readonly Snapshot[];
  typing: boolean;
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

export const UNDO_STEPS_MAX = 100;
export const PASTE_COLLAPSE_LINES = 3;
export const PASTE_COLLAPSE_CHARACTERS = 800;

export const emptyEditor = (history: readonly string[] = []): EditorState => ({ text: '', cursor: 0, history, historyIndex: undefined, draft: '', draftPastes: [], killed: undefined, pastes: [], pasteCount: 0, undo: [], typing: false });

const LINE_CONTINUATION = '\\';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const words = new Intl.Segmenter(undefined, { granularity: 'word' });

type Range = { start: number; end: number };

const spansOf = (state: EditorState): Range[] => state.pastes.map(({ start, label }) => ({ start, end: start + label.length }));

const shiftedSpans = (pastes: readonly PastedSpan[], start: number, end: number, inserted: number): PastedSpan[] =>
  pastes.flatMap((paste) => {
    const spanEnd = paste.start + paste.label.length;
    if (spanEnd <= start) return [paste];
    if (paste.start >= end) return [{ ...paste, start: paste.start + inserted - (end - start) }];
    return [];
  });

const graphemeCount = (text: string): number => [...graphemes.segment(text)].length;

const offsetAfterGraphemes = (text: string, from: number, to: number, count: number): number => {
  let taken = 0;
  for (const { index, segment } of graphemes.segment(text.slice(from, to))) {
    if (taken === count) return from + index;
    taken += 1;
    if (taken === count) return from + index + segment.length;
  }
  return to;
};

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

const remembered = (state: EditorState): readonly Snapshot[] => [...state.undo, { text: state.text, cursor: state.cursor, pastes: state.pastes }].slice(-UNDO_STEPS_MAX);

const spliced = (state: EditorState, start: number, end: number, text: string, typing = false): EditorState => ({
  ...state,
  text: state.text.slice(0, start) + text + state.text.slice(end),
  cursor: start + text.length,
  pastes: shiftedSpans(state.pastes, start, end, text.length),
  historyIndex: undefined,
  undo: typing && state.typing ? state.undo : remembered(state),
  typing,
});

const removed = (state: EditorState, start: number, end: number): EditorState => (start === end ? { ...state, typing: false } : spliced(state, start, end, ''));

const killed = (state: EditorState, start: number, end: number): EditorState => (start === end ? { ...state, typing: false } : { ...removed(state, start, end), killed: state.text.slice(start, end) });

const inserted = (state: EditorState, text: string, typing: boolean): EditorState => spliced(state, state.cursor, state.cursor, text, typing);

const lineStart = (text: string, cursor: number): number => text.lastIndexOf('\n', cursor - 1) + 1;

const lineEnd = (text: string, cursor: number): number => {
  const end = text.indexOf('\n', cursor);
  return end < 0 ? text.length : end;
};

const moveVertically = (state: EditorState, direction: -1 | 1): EditorState | undefined => {
  const start = lineStart(state.text, state.cursor);
  const column = graphemeCount(state.text.slice(start, state.cursor));
  if (direction === -1) {
    if (start === 0) return undefined;
    return movedTo(state, offsetAfterGraphemes(state.text, lineStart(state.text, start - 1), start - 1, column));
  }
  const end = lineEnd(state.text, state.cursor);
  if (end >= state.text.length) return undefined;
  const nextStart = end + 1;
  return movedTo(state, offsetAfterGraphemes(state.text, nextStart, lineEnd(state.text, nextStart), column));
};

type Kept = { readonly text: string; readonly pastes: readonly PastedSpan[] };

const recalled = (state: EditorState, shown: Kept, historyIndex: number | undefined, draft: Kept): EditorState => ({
  ...state,
  text: shown.text,
  pastes: shown.pastes,
  cursor: shown.text.length,
  historyIndex,
  draft: draft.text,
  draftPastes: draft.pastes,
  typing: false,
});

const entry = (text: string): Kept => ({ text, pastes: [] });

const recall = (state: EditorState, direction: -1 | 1): EditorState | undefined => {
  if (state.history.length === 0) return undefined;
  if (direction === -1) {
    const index = state.historyIndex === undefined ? state.history.length - 1 : state.historyIndex - 1;
    const text = state.history[index];
    if (index < 0 || text === undefined) return undefined;
    return recalled(state, entry(text), index, state.historyIndex === undefined ? { text: state.text, pastes: state.pastes } : { text: state.draft, pastes: state.draftPastes });
  }
  if (state.historyIndex === undefined) return undefined;
  const index = state.historyIndex + 1;
  const draft = { text: state.draft, pastes: state.draftPastes };
  if (index >= state.history.length) return recalled(state, draft, undefined, draft);
  const text = state.history[index];
  return text === undefined ? undefined : recalled(state, entry(text), index, draft);
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
  return { ...withSpan(state, pastedLabel(number, lines), text), pasteCount: number };
};

const withSpan = (state: EditorState, label: string, text: string): EditorState => {
  const after = inserted(state, label, false);
  return { ...after, pastes: [...after.pastes, { start: state.cursor, label, text }] };
};

export const insertSpan = (state: EditorState, label: string): EditorState => withSpan(state, label, label);

export const expandedText = (state: EditorState): string => {
  let text = '';
  let at = 0;
  for (const paste of state.pastes.toSorted((left, right) => left.start - right.start)) {
    text += state.text.slice(at, paste.start) + paste.text;
    at = paste.start + paste.label.length;
  }
  return text + state.text.slice(at);
};

export const placeText = (state: EditorState, text: string): EditorState => ({ ...spliced(state, 0, state.text.length, text), pastes: [] });

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
  if (state.text[state.cursor - 1] === LINE_CONTINUATION) return { kind: 'newline', state: spliced(state, state.cursor - 1, state.cursor, '\n') };
  if (state.text.trim() === '') return { kind: 'blank' };
  const text = expandedText(state);
  return { kind: 'submit', state: emptyEditor(pushHistory(state.history, text)), text };
};

const EDITOR_CONTEXTS: readonly KeyContext[] = ['chat'];

export const applyKeyEvent = (state: EditorState, event: KeyEvent, keys: KeyTable): EditorOutcome => {
  const action = keys.actionOf(EDITOR_CONTEXTS, event);
  if (isEditorAction(action)) return { state: applyAction(state, action) };
  if (action === 'prompt.submit') {
    const outcome = enterOf(state);
    if (outcome.kind === 'blank') return { state };
    return outcome.kind === 'newline' ? { state: outcome.state } : { state: outcome.state, submit: outcome.text };
  }
  const typed = action === undefined ? keys.typedOf(event) : undefined;
  return typed === undefined ? { state } : { state: insertText(state, typed) };
};
