export type EditorState = {
  text: string;
  cursor: number;
  history: readonly string[];
  historyIndex: number | undefined;
  draft: string;
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

export const emptyEditor = (history: readonly string[] = []): EditorState => ({ text: '', cursor: 0, history, historyIndex: undefined, draft: '' });

const LINE_CONTINUATION = '\\';

const insert = (state: EditorState, text: string): EditorState => ({
  ...state,
  text: state.text.slice(0, state.cursor) + text + state.text.slice(state.cursor),
  cursor: state.cursor + text.length,
  historyIndex: undefined,
});

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
    return { ...state, cursor: Math.min(previousStart + column, start - 1) };
  }
  const end = lineEnd(state.text, state.cursor);
  if (end >= state.text.length) return undefined;
  const nextStart = end + 1;
  return { ...state, cursor: Math.min(nextStart + column, lineEnd(state.text, nextStart)) };
};

const recall = (state: EditorState, direction: -1 | 1): EditorState | undefined => {
  if (state.history.length === 0) return undefined;
  if (direction === -1) {
    const index = state.historyIndex === undefined ? state.history.length - 1 : state.historyIndex - 1;
    if (index < 0) return undefined;
    const text = state.history[index];
    if (text === undefined) return undefined;
    return { ...state, text, cursor: text.length, historyIndex: index, draft: state.historyIndex === undefined ? state.text : state.draft };
  }
  if (state.historyIndex === undefined) return undefined;
  const index = state.historyIndex + 1;
  if (index >= state.history.length) return { ...state, text: state.draft, cursor: state.draft.length, historyIndex: undefined };
  const text = state.history[index];
  if (text === undefined) return undefined;
  return { ...state, text, cursor: text.length, historyIndex: index };
};

const normalizeNewlines = (text: string): string => text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');

export const pushHistory = (history: readonly string[], text: string): readonly string[] => (history.at(-1) === text ? history : [...history, text]);

export const applyKey = (state: EditorState, key: KeyPress): EditorOutcome => {
  if (key.return === true) {
    if (key.shift === true || key.meta === true) return { state: insert(state, '\n') };
    if (state.text[state.cursor - 1] === LINE_CONTINUATION) {
      const without = { ...state, text: state.text.slice(0, state.cursor - 1) + state.text.slice(state.cursor), cursor: state.cursor - 1 };
      return { state: insert(without, '\n') };
    }
    if (state.text.trim() === '') return { state };
    return { state: emptyEditor(pushHistory(state.history, state.text)), submit: state.text };
  }
  if (key.ctrl === true) {
    switch (key.input) {
      case 'j':
        return { state: insert(state, '\n') };
      case 'a':
        return { state: { ...state, cursor: lineStart(state.text, state.cursor) } };
      case 'e':
        return { state: { ...state, cursor: lineEnd(state.text, state.cursor) } };
      case 'u':
        return { state: { ...state, text: state.text.slice(state.cursor), cursor: 0 } };
      case 'k':
        return { state: { ...state, text: state.text.slice(0, state.cursor) } };
      default:
        return { state };
    }
  }
  if (key.backspace === true || key.delete === true) {
    if (state.cursor === 0) return { state };
    return { state: { ...state, text: state.text.slice(0, state.cursor - 1) + state.text.slice(state.cursor), cursor: state.cursor - 1, historyIndex: undefined } };
  }
  if (key.leftArrow === true) return { state: { ...state, cursor: Math.max(0, state.cursor - 1) } };
  if (key.rightArrow === true) return { state: { ...state, cursor: Math.min(state.text.length, state.cursor + 1) } };
  if (key.home === true) return { state: { ...state, cursor: lineStart(state.text, state.cursor) } };
  if (key.end === true) return { state: { ...state, cursor: lineEnd(state.text, state.cursor) } };
  if (key.upArrow === true) return { state: moveVertically(state, -1) ?? recall(state, -1) ?? state };
  if (key.downArrow === true) return { state: moveVertically(state, 1) ?? recall(state, 1) ?? state };
  if (key.meta === true || key.input === '') return { state };
  return { state: insert(state, normalizeNewlines(key.input)) };
};
