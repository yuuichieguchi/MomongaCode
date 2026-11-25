import { describe, expect, it } from 'vitest';
import { EDITOR_ACTIONS } from '../../src/tui/editor.ts';
import { createKeyTable, DEFAULT_KEY_TABLE, KEYS, KEY_CONTEXTS, keySpecOf, RESERVED_KEYS } from '../../src/tui/keys/table.ts';
import type { KeyEvent, KeyName } from '../../src/tui/terminal/events.ts';
import { MENU_ACTIONS } from '../../src/tui/screen/menu.tsx';

const plain = { ctrl: false, alt: false, shift: false, super: false, hyper: false, meta: false };
const named = (name: KeyName, mods: Partial<typeof plain> = {}): KeyEvent => ({ type: 'key', name, ...plain, ...mods });
const text = (value: string, mods: Partial<typeof plain> = {}): KeyEvent => ({ type: 'key', text: value, ...plain, ...mods });

describe('the key table', () => {
  it('names a key event the way the table writes it, and gives typed text no name', () => {
    expect(keySpecOf(named('enter', { shift: true }))).toBe('shift+enter');
    expect(keySpecOf(named('left', { ctrl: true }))).toBe('ctrl+left');
    expect(keySpecOf(text('K', { ctrl: true }))).toBe('ctrl+k');
    expect(keySpecOf(text('b', { alt: true }))).toBe('alt+b');
    expect(keySpecOf(text('_', { ctrl: true }))).toBe('ctrl+_');
    expect(keySpecOf(text('a'))).toBeUndefined();
    expect(keySpecOf(text(' '))).toBeUndefined();
  });

  it('names every modifier a terminal reports, cmd first', () => {
    expect(keySpecOf(text('z', { super: true }))).toBe('cmd+z');
    expect(keySpecOf(text('Z', { super: true, shift: true }))).toBe('cmd+shift+z');
    expect(keySpecOf(text('k', { hyper: true }))).toBe('hyper+k');
    expect(keySpecOf(text('k', { meta: true }))).toBe('meta+k');
    expect(keySpecOf(named('enter', { super: true, hyper: true, meta: true, ctrl: true, alt: true, shift: true }))).toBe('cmd+hyper+meta+ctrl+alt+shift+enter');
    expect(keySpecOf(named('enter', { ctrl: true }))).toBe('ctrl+enter');
  });

  it('never types a key pressed with cmd, hyper or meta, and gives it no action when no row binds it', () => {
    for (const modifier of ['super', 'hyper', 'meta'] as const) {
      const pressed = text('z', { [modifier]: true });
      expect(DEFAULT_KEY_TABLE.typedOf(pressed)).toBeUndefined();
      for (const context of KEY_CONTEXTS) {
        expect(DEFAULT_KEY_TABLE.actionOf([context], pressed)).toBeUndefined();
        expect(DEFAULT_KEY_TABLE.chordStep([context], undefined, pressed)).toEqual({ kind: 'none' });
      }
    }
    expect(DEFAULT_KEY_TABLE.typedOf(text('z'))).toBe('z');
    expect(DEFAULT_KEY_TABLE.typedOf(text('Z', { shift: true }))).toBe('Z');
  });

  it('gives a key pressed with cmd the action of the row that binds it', () => {
    const table = createKeyTable(KEYS.map((row) => (row.id === 'selection.copy' ? { ...row, default: ['cmd+c'] } : row)));
    expect(table.actionOf(['viewport'], text('c', { super: true }))).toBe('selection.copy');
    expect(table.actionOf(['viewport'], text('c'))).toBeUndefined();
    expect(table.actionOf(['viewport'], text('c', { ctrl: true, shift: true }))).toBeUndefined();
  });

  it.each<[KeyEvent, string]>([
    [named('enter'), 'prompt.submit'],
    [named('enter', { shift: true }), 'prompt.newline'],
    [named('enter', { alt: true }), 'prompt.newline'],
    [text('j', { ctrl: true }), 'prompt.newline'],
    [named('backspace'), 'editor.deleteBefore'],
    [named('delete'), 'editor.deleteAfter'],
    [text('a', { ctrl: true }), 'editor.lineStart'],
    [named('home'), 'editor.lineStart'],
    [text('e', { ctrl: true }), 'editor.lineEnd'],
    [named('end'), 'editor.lineEnd'],
    [named('left'), 'editor.left'],
    [named('right'), 'editor.right'],
    [named('left', { alt: true }), 'editor.wordLeft'],
    [text('b', { alt: true }), 'editor.wordLeft'],
    [named('left', { ctrl: true }), 'editor.wordLeft'],
    [named('right', { alt: true }), 'editor.wordRight'],
    [text('f', { alt: true }), 'editor.wordRight'],
    [named('right', { ctrl: true }), 'editor.wordRight'],
    [text('u', { ctrl: true }), 'editor.killLineStart'],
    [text('k', { ctrl: true }), 'editor.killLineEnd'],
    [text('w', { ctrl: true }), 'editor.killWordBefore'],
    [text('d', { alt: true }), 'editor.killWordAfter'],
    [text('y', { ctrl: true }), 'editor.yank'],
    [text('_', { ctrl: true }), 'editor.undo'],
    [named('up'), 'editor.up'],
    [named('down'), 'editor.down'],
    [text('r', { ctrl: true }), 'history.search'],
    [text('g', { ctrl: true }), 'editor.external'],
    [text('o', { ctrl: true }), 'transcript.detail'],
    [named('tab', { shift: true }), 'mode.cycle'],
    [named('escape'), 'run.stop'],
    [text('c', { ctrl: true }), 'prompt.interrupt'],
    [text('d', { ctrl: true }), 'prompt.exit'],
    [text('l', { ctrl: true }), 'screen.repaint'],
  ])('gives %j the editor action %s', (event, action) => {
    expect(DEFAULT_KEY_TABLE.actionOf(['chat', 'global'], event)).toBe(action);
  });

  it('gives Tab the queue action of a working run, and typed text no editor action', () => {
    expect(DEFAULT_KEY_TABLE.actionOf(['chat', 'global'], named('tab'))).toBe('prompt.queue');
    expect(DEFAULT_KEY_TABLE.actionOf(['chat', 'global'], text('x'))).toBeUndefined();
  });

  it.each<[KeyEvent, string]>([
    [named('up'), 'menu.up'],
    [named('down'), 'menu.down'],
    [named('tab'), 'menu.complete'],
    [named('enter'), 'menu.run'],
    [named('escape'), 'menu.close'],
    [text('c', { ctrl: true }), 'menu.close'],
  ])('gives %j the menu action %s', (event, action) => {
    expect(DEFAULT_KEY_TABLE.actionOf(['menu'], event)).toBe(action);
  });

  it('holds one row per action, each in a known context with at least one key', () => {
    expect(new Set(KEYS.map((row) => row.id)).size).toBe(KEYS.length);
    for (const row of KEYS) {
      expect(KEY_CONTEXTS).toContain(row.context);
      expect(row.default.length).toBeGreaterThan(0);
    }
  });

  it('binds no key to two actions of one context, except Enter, which submits when idle and steers while a run works', () => {
    expect(KEYS.find((row) => row.id === 'prompt.steer')).toMatchObject({ context: 'chat', default: KEYS.find((row) => row.id === 'prompt.submit')?.default });
    for (const context of KEY_CONTEXTS) {
      const keys = KEYS.filter((row) => row.context === context && row.id !== 'prompt.steer').flatMap((row) => [...row.default]);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('has a row for every action the editor and the menu act on', () => {
    const ids: readonly string[] = KEYS.map((row) => row.id);
    for (const action of [...EDITOR_ACTIONS, ...MENU_ACTIONS]) expect(ids).toContain(action);
  });

  it('names the keys in force in a hint, and a rebound table names the new key and not the old', () => {
    expect(DEFAULT_KEY_TABLE.hintFor('prompt.interrupt')).toBe('ctrl+c');
    expect(DEFAULT_KEY_TABLE.hintFor('run.stop')).toBe('esc');
    expect(DEFAULT_KEY_TABLE.hintFor('editor.lineStart')).toBe('ctrl+a or home');
    const rebound = createKeyTable(KEYS.map((row) => (row.id === 'history.search' ? { ...row, default: ['ctrl+s'] } : row)));
    expect(rebound.hintFor('history.search')).toBe('ctrl+s');
    expect(rebound.actionOf(['chat'], text('s', { ctrl: true }))).toBe('history.search');
    expect(rebound.actionOf(['chat'], text('r', { ctrl: true }))).toBeUndefined();
  });

  it('lists the keys whose meaning the terminal decides', () => {
    expect(RESERVED_KEYS).toEqual(['ctrl+c', 'ctrl+d', 'ctrl+z', 'ctrl+m', 'ctrl+i', 'ctrl+[']);
  });

  it.each<[KeyEvent, string]>([
    [named('tab'), 'inspector.tabNext'],
    [named('right'), 'inspector.tabNext'],
    [named('tab', { shift: true }), 'inspector.tabPrev'],
    [named('left'), 'inspector.tabPrev'],
  ])('gives %j in inspector context the action %s', (event, action) => {
    expect(DEFAULT_KEY_TABLE.actionOf(['inspector'], event)).toBe(action);
  });
});
