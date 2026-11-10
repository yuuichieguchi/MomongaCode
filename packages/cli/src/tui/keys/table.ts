import type { KeyEvent } from '../terminal/events.ts';

export const KEY_CONTEXTS = ['chat', 'menu', 'select', 'viewport', 'viewer', 'shell', 'global'] as const;

export type KeyContext = (typeof KEY_CONTEXTS)[number];

export type KeySpec = string;

export type KeyRow = { readonly id: string; readonly context: KeyContext; readonly default: readonly KeySpec[]; readonly description: string };

export const KEYS = [
  { id: 'prompt.submit', context: 'chat', default: ['enter'], description: 'send the message or run the command' },
  { id: 'prompt.newline', context: 'chat', default: ['shift+enter', 'alt+enter', 'ctrl+j'], description: 'new line' },
  { id: 'editor.deleteBefore', context: 'chat', default: ['backspace'], description: 'delete before the caret' },
  { id: 'editor.deleteAfter', context: 'chat', default: ['delete'], description: 'delete after the caret' },
  { id: 'editor.lineStart', context: 'chat', default: ['ctrl+a', 'home'], description: 'line start' },
  { id: 'editor.lineEnd', context: 'chat', default: ['ctrl+e', 'end'], description: 'line end' },
  { id: 'editor.left', context: 'chat', default: ['left'], description: 'one character left' },
  { id: 'editor.right', context: 'chat', default: ['right'], description: 'one character right' },
  { id: 'editor.wordLeft', context: 'chat', default: ['alt+left', 'alt+b', 'ctrl+left'], description: 'one word left' },
  { id: 'editor.wordRight', context: 'chat', default: ['alt+right', 'alt+f', 'ctrl+right'], description: 'one word right' },
  { id: 'editor.killLineStart', context: 'chat', default: ['ctrl+u'], description: 'delete to the line start' },
  { id: 'editor.killLineEnd', context: 'chat', default: ['ctrl+k'], description: 'delete to the line end' },
  { id: 'editor.killWordBefore', context: 'chat', default: ['ctrl+w'], description: 'delete the word before the caret' },
  { id: 'editor.killWordAfter', context: 'chat', default: ['alt+d'], description: 'delete the word after the caret' },
  { id: 'editor.yank', context: 'chat', default: ['ctrl+y'], description: 'insert the text last deleted' },
  { id: 'editor.undo', context: 'chat', default: ['ctrl+_'], description: 'undo' },
  { id: 'editor.up', context: 'chat', default: ['up'], description: 'line up, then older history' },
  { id: 'editor.down', context: 'chat', default: ['down'], description: 'line down, then newer history' },
  { id: 'history.search', context: 'chat', default: ['ctrl+r'], description: 'search the history' },
  { id: 'editor.external', context: 'chat', default: ['ctrl+g'], description: 'edit the draft in $VISUAL or $EDITOR' },
  { id: 'transcript.detail', context: 'chat', default: ['ctrl+o'], description: 'show or fold the detail' },
  { id: 'mode.cycle', context: 'chat', default: ['shift+tab'], description: 'cycles the mode' },
  { id: 'run.stop', context: 'chat', default: ['escape'], description: 'stops the run' },
  { id: 'prompt.interrupt', context: 'chat', default: ['ctrl+c'], description: 'cancel the run or clear the input; twice on an empty input to exit' },
  { id: 'prompt.exit', context: 'chat', default: ['ctrl+d'], description: 'twice on an empty input to exit' },
  { id: 'menu.up', context: 'menu', default: ['up'], description: 'move up in the menu' },
  { id: 'menu.down', context: 'menu', default: ['down'], description: 'move down in the menu' },
  { id: 'menu.complete', context: 'menu', default: ['tab'], description: 'complete the highlighted command' },
  { id: 'menu.run', context: 'menu', default: ['enter'], description: 'run the highlighted command' },
  { id: 'menu.close', context: 'menu', default: ['escape', 'ctrl+c'], description: 'close the menu' },
  { id: 'select.up', context: 'select', default: ['up', 'ctrl+p'], description: 'move up' },
  { id: 'select.down', context: 'select', default: ['down', 'ctrl+n'], description: 'move down' },
  { id: 'select.pageUp', context: 'select', default: ['pageup'], description: 'move up by a page' },
  { id: 'select.pageDown', context: 'select', default: ['pagedown'], description: 'move down by a page' },
  { id: 'select.first', context: 'select', default: ['home'], description: 'move to the first row' },
  { id: 'select.last', context: 'select', default: ['end'], description: 'move to the last row' },
  { id: 'select.decide', context: 'select', default: ['enter'], description: 'choose the highlighted row' },
  { id: 'select.escape', context: 'select', default: ['escape'], description: 'decline or go back' },
  { id: 'select.interrupt', context: 'select', default: ['ctrl+c'], description: 'interrupt' },
  { id: 'viewport.pageUp', context: 'viewport', default: ['pageup'], description: 'scroll up half a screen' },
  { id: 'viewport.pageDown', context: 'viewport', default: ['pagedown'], description: 'scroll down half a screen' },
  { id: 'viewport.top', context: 'viewport', default: ['ctrl+home'], description: 'go to the top' },
  { id: 'viewport.bottom', context: 'viewport', default: ['ctrl+end', 'end'], description: 'go to the bottom' },
  { id: 'screen.repaint', context: 'global', default: ['ctrl+l'], description: 'repaint the screen' },
  { id: 'screen.suspend', context: 'global', default: ['ctrl+z'], description: 'suspend' },
] as const satisfies readonly KeyRow[];

export type ActionId = (typeof KEYS)[number]['id'];

export type ActionRow = KeyRow & { readonly id: ActionId };

export const RESERVED_KEYS: readonly KeySpec[] = ['ctrl+c', 'ctrl+d', 'ctrl+z', 'ctrl+m', 'ctrl+i', 'ctrl+['];

const SPACE = 'space';

export const keySpecOf = (event: KeyEvent): KeySpec | undefined => {
  const named = 'name' in event;
  if (!named && !event.ctrl && !event.alt) return undefined;
  const key = named ? event.name : event.text === ' ' ? SPACE : event.text.toLowerCase();
  return `${event.ctrl ? 'ctrl+' : ''}${event.alt ? 'alt+' : ''}${event.shift ? 'shift+' : ''}${key}`;
};

const SHOWN_AS: Readonly<Record<string, string>> = { escape: 'esc' };

const shown = (spec: KeySpec): string =>
  spec
    .split('+')
    .map((part) => SHOWN_AS[part] ?? part)
    .join('+');

const HINT_JOIN = ' or ';

export type KeyTable = {
  rows(): readonly ActionRow[];
  keysFor(id: ActionId): readonly KeySpec[];
  hintFor(id: ActionId, reported?: (spec: KeySpec) => boolean): string;
  actionOf(contexts: readonly KeyContext[], event: KeyEvent): ActionId | undefined;
};

export const createKeyTable = (rows: readonly ActionRow[] = KEYS): KeyTable => {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const keysFor = (id: ActionId): readonly KeySpec[] => {
    const row = byId.get(id);
    if (row === undefined) throw new Error(`no key row ${id}`);
    return row.default;
  };
  return {
    rows: () => rows,
    keysFor,
    hintFor: (id, reported = () => true) => keysFor(id).filter(reported).map(shown).join(HINT_JOIN),
    actionOf: (contexts, event) => {
      const spec = keySpecOf(event);
      if (spec === undefined) return undefined;
      for (const context of contexts) {
        const row = rows.find((candidate) => candidate.context === context && candidate.default.includes(spec));
        if (row !== undefined) return row.id;
      }
      return undefined;
    },
  };
};

export const DEFAULT_KEY_TABLE: KeyTable = createKeyTable();
