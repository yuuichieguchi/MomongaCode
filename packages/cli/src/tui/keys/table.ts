import type { KeyEvent, KeyModifiers } from '../terminal/events.ts';
import { NEWLINE_HINT } from '../terminal/negotiation.ts';
import type { NegotiationState } from '../terminal/negotiation.ts';

export const KEY_CONTEXTS = ['chat', 'menu', 'agents', 'select', 'viewport', 'viewer', 'shell', 'global'] as const;

export type KeyContext = (typeof KEY_CONTEXTS)[number];

export type KeySpec = string;

export type KeyRow = { readonly id: string; readonly context: KeyContext; readonly default: readonly KeySpec[]; readonly description: string };

export const BUSY_KEYS = { enter: 'steer', second: 'tab' } as const;

export const KEYS = [
  { id: 'prompt.submit', context: 'chat', default: ['enter'], description: 'send the message or run the command' },
  { id: 'prompt.queue', context: 'chat', default: ['tab'], description: 'while a run works: queue the message for after this run' },
  { id: 'prompt.steer', context: 'chat', default: ['enter'], description: 'while a run works: steer the run with the message after the next tool call' },
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
  { id: 'editor.submitValue', context: 'select', default: ['ctrl+x enter'], description: 'confirm the value of the structured editor' },
  { id: 'transcript.detail', context: 'chat', default: ['ctrl+o'], description: 'show or fold the detail' },
  { id: 'mode.cycle', context: 'chat', default: ['shift+tab'], description: 'cycles the mode' },
  { id: 'run.stop', context: 'chat', default: ['escape'], description: 'stops the run' },
  { id: 'prompt.interrupt', context: 'chat', default: ['ctrl+c'], description: 'cancel the run or clear the input; twice on an empty input to exit' },
  { id: 'prompt.exit', context: 'chat', default: ['ctrl+d'], description: 'twice on an empty input to exit' },
  { id: 'prompt.pasteImage', context: 'chat', default: ['ctrl+v', 'alt+v'], description: 'paste an image from the clipboard' },
  { id: 'shell.run', context: 'shell', default: ['enter'], description: 'run the command' },
  { id: 'shell.leave', context: 'shell', default: ['escape'], description: 'leave the shell mode' },
  { id: 'menu.up', context: 'menu', default: ['up'], description: 'move up in the menu' },
  { id: 'menu.down', context: 'menu', default: ['down'], description: 'move down in the menu' },
  { id: 'menu.complete', context: 'menu', default: ['tab'], description: 'complete the highlighted command' },
  { id: 'menu.run', context: 'menu', default: ['enter'], description: 'run the highlighted command' },
  { id: 'menu.close', context: 'menu', default: ['escape', 'ctrl+c'], description: 'close the menu' },
  { id: 'agents.previous', context: 'agents', default: ['up'], description: 'the row above in the list of views; above main, back to the input' },
  { id: 'agents.next', context: 'agents', default: ['down'], description: 'the row below in the list of views' },
  { id: 'agents.open', context: 'agents', default: ['enter'], description: 'show the view of the chosen row: main or a running subagent' },
  { id: 'select.up', context: 'select', default: ['up', 'ctrl+p', 'k'], description: 'move up' },
  { id: 'select.down', context: 'select', default: ['down', 'ctrl+n', 'j'], description: 'move down' },
  { id: 'select.pageUp', context: 'select', default: ['pageup'], description: 'move up by a page' },
  { id: 'select.pageDown', context: 'select', default: ['pagedown'], description: 'move down by a page' },
  { id: 'select.first', context: 'select', default: ['home'], description: 'move to the first row' },
  { id: 'select.last', context: 'select', default: ['end'], description: 'move to the last row' },
  { id: 'select.decide', context: 'select', default: ['enter'], description: 'choose the highlighted row' },
  { id: 'select.escape', context: 'select', default: ['escape'], description: 'decline or go back' },
  { id: 'select.interrupt', context: 'select', default: ['ctrl+c'], description: 'interrupt' },
  { id: 'select.alt', context: 'select', default: ['tab'], description: 'the second choice of a list that has one' },
  { id: 'select.detail', context: 'select', default: ['ctrl+o'], description: 'show all of what is asked' },
  { id: 'select.filterBack', context: 'select', default: ['backspace'], description: 'delete the last character of the filter' },
  { id: 'select.delete', context: 'select', default: ['delete'], description: 'delete the highlighted row of a list that has it, after asking' },
  { id: 'select.copy', context: 'select', default: ['ctrl+y'], description: 'copy the sign-in URL' },
  { id: 'viewport.pageUp', context: 'viewport', default: ['pageup'], description: 'scroll up half a screen' },
  { id: 'viewport.pageDown', context: 'viewport', default: ['pagedown'], description: 'scroll down half a screen' },
  { id: 'viewport.top', context: 'viewport', default: ['ctrl+home'], description: 'go to the top' },
  { id: 'viewport.bottom', context: 'viewport', default: ['ctrl+end', 'end'], description: 'go to the bottom' },
  { id: 'selection.copy', context: 'viewport', default: ['ctrl+shift+c'], description: 'copy the selection' },
  { id: 'selection.clear', context: 'viewport', default: ['escape'], description: 'clear the selection' },
  { id: 'viewer.up', context: 'viewer', default: ['up'], description: 'scroll up a line' },
  { id: 'viewer.down', context: 'viewer', default: ['down'], description: 'scroll down a line' },
  { id: 'viewer.pageUp', context: 'viewer', default: ['pageup'], description: 'scroll up a page' },
  { id: 'viewer.pageDown', context: 'viewer', default: ['pagedown'], description: 'scroll down a page' },
  { id: 'viewer.first', context: 'viewer', default: ['home'], description: 'go to the first line' },
  { id: 'viewer.last', context: 'viewer', default: ['end'], description: 'go to the last line' },
  { id: 'viewer.older', context: 'viewer', default: ['tab'], description: 'the next older tool output' },
  { id: 'viewer.newer', context: 'viewer', default: ['shift+tab'], description: 'the next newer tool output' },
  { id: 'viewer.close', context: 'viewer', default: ['escape'], description: 'return' },
  { id: 'screen.repaint', context: 'global', default: ['ctrl+l'], description: 'repaint the screen' },
  { id: 'screen.suspend', context: 'global', default: ['ctrl+z'], description: 'suspend' },
] as const satisfies readonly KeyRow[];

export type ActionId = (typeof KEYS)[number]['id'];

export type ActionRow = KeyRow & { readonly id: ActionId };

export const RESERVED_KEYS: readonly KeySpec[] = ['ctrl+c', 'ctrl+d', 'ctrl+z', 'ctrl+m', 'ctrl+i', 'ctrl+['];

const SPACE = 'space';
const CHORD_JOIN = ' ';

const MODIFIER_WORDS = [
  ['super', 'cmd'],
  ['hyper', 'hyper'],
  ['meta', 'meta'],
  ['ctrl', 'ctrl'],
  ['alt', 'alt'],
  ['shift', 'shift'],
] as const satisfies readonly (readonly [keyof KeyModifiers, string])[];

export const MODIFIER_ORDER: readonly string[] = MODIFIER_WORDS.map(([, word]) => word);

const REPORTED_ONLY_BY_PROTOCOL: readonly string[] = ['cmd', 'hyper', 'meta'];

const typedTextOf = (event: KeyEvent): string | undefined => ('text' in event && !event.ctrl && !event.alt && !event.super && !event.hyper && !event.meta ? event.text : undefined);

export const keySpecOf = (event: KeyEvent): KeySpec | undefined => {
  if (typedTextOf(event) !== undefined) return undefined;
  const key = 'name' in event ? event.name : event.text === ' ' ? SPACE : event.text.toLowerCase();
  return `${MODIFIER_WORDS.map(([held, word]) => (event[held] ? `${word}+` : '')).join('')}${key}`;
};

export const pressedSpecOf = (event: KeyEvent): KeySpec => keySpecOf(event) ?? ('text' in event && event.text !== ' ' ? event.text : SPACE);

export const isPlainKey = (spec: KeySpec): boolean => !spec.includes('+') && [...spec].length === 1;

export const chordOf = (parts: readonly KeySpec[]): KeySpec => parts.join(CHORD_JOIN);

export const chordParts = (spec: KeySpec): KeySpec[] => spec.split(CHORD_JOIN);

const SHOWN_AS: Readonly<Record<string, string>> = { escape: 'esc' };

export const shownKey = (spec: KeySpec): string =>
  chordParts(spec)
    .map((part) =>
      part
        .split('+')
        .map((word) => SHOWN_AS[word] ?? word)
        .join('+'),
    )
    .join(CHORD_JOIN);

const HINT_JOIN = ' or ';

const LEGACY_NAMED = ['enter', 'tab', 'backspace', 'escape', 'space'];
const LEGACY_BACKTAB = 'shift+tab';

const partNeedsReport = (part: KeySpec): boolean => {
  const words = part.split('+');
  const key = words.at(-1) ?? '';
  const modifiers = words.slice(0, -1);
  if (modifiers.some((modifier) => REPORTED_ONLY_BY_PROTOCOL.includes(modifier))) return true;
  if (LEGACY_NAMED.includes(key)) return part !== LEGACY_BACKTAB && (modifiers.includes('ctrl') || modifiers.includes('shift'));
  return [...key].length === 1 && modifiers.includes('ctrl') && modifiers.includes('shift');
};

export const needsReport = (spec: KeySpec): boolean => chordParts(spec).some(partNeedsReport);

export const sentAsEscape = (spec: KeySpec): boolean => chordParts(spec).some((part) => part.split('+').slice(0, -1).includes('alt'));

export const reportsModifiedKeys = (negotiation: NegotiationState): boolean => needsReport(NEWLINE_HINT[negotiation]);

export const keyReported = (spec: KeySpec, negotiation: NegotiationState): boolean => !needsReport(spec) || reportsModifiedKeys(negotiation);

export type ChordStep = { readonly kind: 'none' } | { readonly kind: 'pending'; readonly prefix: KeySpec } | { readonly kind: 'action'; readonly id: ActionId } | { readonly kind: 'dropped' };

export type KeyTable = {
  rows(): readonly ActionRow[];
  keysFor(id: ActionId): readonly KeySpec[];
  hintFor(id: ActionId, reported?: (spec: KeySpec) => boolean): string;
  keyHint(id: ActionId): string;
  actionOf(contexts: readonly KeyContext[], event: KeyEvent, plain?: 'plain'): ActionId | undefined;
  typedOf(event: KeyEvent): string | undefined;
  chordStep(contexts: readonly KeyContext[], pending: KeySpec | undefined, event: KeyEvent): ChordStep;
};

export const createKeyTable = (rows: readonly ActionRow[] = KEYS): KeyTable => {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const keysFor = (id: ActionId): readonly KeySpec[] => {
    const row = byId.get(id);
    if (row === undefined) throw new Error(`no key row ${id}`);
    return row.default;
  };
  const rowOf = (contexts: readonly KeyContext[], spec: KeySpec): ActionRow | undefined => {
    for (const context of contexts) {
      const row = rows.find((candidate) => candidate.context === context && candidate.default.includes(spec));
      if (row !== undefined) return row;
    }
    return undefined;
  };
  const startsWith = (contexts: readonly KeyContext[], prefix: KeySpec): boolean => rows.some((row) => contexts.includes(row.context) && row.default.some((spec) => spec.startsWith(`${prefix}${CHORD_JOIN}`)));
  return {
    rows: () => rows,
    keysFor,
    hintFor: (id, reported = () => true) => keysFor(id).filter(reported).map(shownKey).join(HINT_JOIN),
    keyHint: (id) => {
      const [first] = keysFor(id);
      return first === undefined ? '' : shownKey(first);
    },
    actionOf: (contexts, event, plain) => {
      const spec = plain === undefined ? keySpecOf(event) : pressedSpecOf(event);
      return spec === undefined ? undefined : rowOf(contexts, spec)?.id;
    },
    typedOf: typedTextOf,
    chordStep: (contexts, pending, event) => {
      const pressed = pressedSpecOf(event);
      if (pending === undefined) return startsWith(contexts, pressed) ? { kind: 'pending', prefix: pressed } : { kind: 'none' };
      const whole = chordOf([pending, pressed]);
      const row = rowOf(contexts, whole);
      if (row !== undefined) return { kind: 'action', id: row.id };
      return startsWith(contexts, whole) ? { kind: 'pending', prefix: whole } : { kind: 'dropped' };
    },
  };
};

export const DEFAULT_KEY_TABLE: KeyTable = createKeyTable();

export const chordPressOf = (keys: KeyTable, id: ActionId): KeyTable => {
  const context = keys.rows().find((row) => row.id === id)?.context;
  return { ...keys, actionOf: (contexts) => (context !== undefined && contexts.includes(context) ? id : undefined), typedOf: () => undefined };
};

export const newlineKeyHint = (keys: KeyTable, negotiation: NegotiationState): string => {
  const acting = keys.keysFor('prompt.newline').find((spec) => !sentAsEscape(spec) && keyReported(spec, negotiation));
  return acting === undefined ? '' : shownKey(acting);
};
