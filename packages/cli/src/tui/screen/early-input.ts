import { insertPaste } from '../editor.ts';
import type { EditorState } from '../editor.ts';
import type { KeyContext, KeyTable } from '../keys/table.ts';
import type { TerminalEvent } from '../terminal/events.ts';
import { typedIntoDraft } from '../user-shell.ts';
import type { ScreenInput } from './input.ts';

export type EarlyItem = { readonly kind: 'typed'; readonly text: string } | { readonly kind: 'paste'; readonly text: string };

export type EarlyInput = {
  take(): readonly EarlyItem[];
  stop(): readonly EarlyItem[];
};

const EARLY_KEY_CONTEXTS: readonly KeyContext[] = ['chat', 'global'];

/** Fold buffered pre-render text and pastes into an editor state in arrival order. */
export const applyEarlyInput = (editor: EditorState, items: readonly EarlyItem[]): EditorState =>
  items.reduce((state, item) => (item.kind === 'paste' ? insertPaste(state, item.text) : typedIntoDraft(state, item.text)), editor);

/** Collect typed characters and bracketed pastes before App claims typing, dropping other keys and mouse events. */
export const createEarlyInput = (input: Pick<ScreenInput, 'claim'>, keys: () => KeyTable): EarlyInput => {
  const queue: EarlyItem[] = [];
  let stopped = false;
  const unclaim = input.claim('early', (event: TerminalEvent): boolean => {
    if (event.type === 'paste') {
      queue.push({ kind: 'paste', text: event.text });
      return true;
    }
    if (event.type === 'key') {
      const table = keys();
      const action = table.actionOf(EARLY_KEY_CONTEXTS, event);
      const typed = table.typedOf(event);
      if (action === undefined && typed !== undefined) queue.push({ kind: 'typed', text: typed });
      return true;
    }
    return event.type === 'mouse';
  });
  return {
    take: () => queue.splice(0),
    stop: () => {
      if (!stopped) {
        stopped = true;
        unclaim();
      }
      return queue.splice(0);
    },
  };
};
