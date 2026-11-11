import { describe, expect, it, vi } from 'vitest';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';
import { KEY_FILE_MAX_BYTES, isReserved, keyDocumentText, parseKey, parseKeyFile, resolveBindings, withAllDefaults, withBinding, withDefaultsOf, withoutKeysOf } from '../../src/tui/keys/bindings.ts';
import type { BindingReport } from '../../src/tui/keys/bindings.ts';
import { capturedOf, captureTitle } from '../../src/tui/keys/capture.ts';
import { createKeyBindings, ignoredNotice, KEY_FILE_MODE, KEY_FILE_STAT_MS } from '../../src/tui/keys/store.ts';
import type { KeyFiles } from '../../src/tui/keys/store.ts';
import { chordPressOf, createKeyTable, DEFAULT_KEY_TABLE, KEYS, keyReported, needsReport, newlineKeyHint } from '../../src/tui/keys/table.ts';
import type { ActionId, KeyContext } from '../../src/tui/keys/table.ts';
import type { KeyEvent, KeyName } from '../../src/tui/terminal/events.ts';
import { seeded } from './screen-fakes.ts';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const plain = { ctrl: false, alt: false, shift: false, super: false, hyper: false, meta: false };
const named = (name: KeyName, mods: Partial<typeof plain> = {}): KeyEvent => ({ type: 'key', name, ...plain, ...mods });
const text = (value: string, mods: Partial<typeof plain> = {}): KeyEvent => ({ type: 'key', text: value, ...plain, ...mods });

const file = (...blocks: [string, Record<string, string | null>][]) => ({ bindings: blocks.map(([context, bindings]) => ({ context, bindings })) });

const keysOf = (report: BindingReport, id: ActionId): readonly string[] => report.rows.find((row) => row.id === id)?.default ?? [];

const rejections = (report: BindingReport): string[] => report.entries.flatMap((entry) => (entry.rejected === undefined ? [] : [`${entry.context} ${entry.key}: ${entry.rejected}`]));

describe('the written form of a key', () => {
  it.each([
    ['ctrl+e', 'ctrl+e'],
    ['Ctrl+E', 'ctrl+e'],
    ['opt+left', 'alt+left'],
    ['option+b', 'alt+b'],
    ['meta+f', 'alt+f'],
    ['shift+ctrl+k', 'ctrl+shift+k'],
    ['cmd+k', 'cmd+k'],
    ['cmd+c', 'cmd+c'],
    ['Cmd+Shift+Z', 'cmd+shift+z'],
    ['super+k', 'cmd+k'],
    ['hyper+k', 'hyper+k'],
    ['shift+ctrl+hyper+cmd+k', 'cmd+hyper+ctrl+shift+k'],
    ['esc', 'escape'],
    ['escape', 'escape'],
    ['space', 'space'],
    ['pageup', 'pageup'],
    ['f5', 'f5'],
    ['k', 'k'],
    ['K', 'K'],
    ['ctrl+x enter', 'ctrl+x enter'],
    ['ctrl+x  ctrl+s', 'ctrl+x ctrl+s'],
    ['ctrl++', 'ctrl++'],
    ['+', '+'],
  ])('reads %j as %s', (written, spec) => {
    expect(parseKey(written)).toBe(spec);
  });

  it.each(['', 'ctrl+', 'fn+k', 'ctrl+enterr', 'ctrl+ab', 'ctrl+x  ctrl+', 'foo'])('cannot read %j', (written) => {
    expect(parseKey(written)).toBeUndefined();
  });

  it('knows the reserved keys, alone and inside a chord', () => {
    for (const key of ['ctrl+c', 'ctrl+d', 'ctrl+z', 'ctrl+m', 'ctrl+i', 'ctrl+[']) expect(isReserved(key)).toBe(true);
    expect(isReserved('ctrl+x ctrl+c')).toBe(true);
    expect(isReserved('ctrl+k')).toBe(false);
  });
});

describe('a key-binding file resolved against the table', () => {
  it('leaves the defaults when the file binds nothing', () => {
    expect(resolveBindings(file())).toEqual({ rows: KEYS, entries: [] });
  });

  it('adds a key to its action before the default keys, and unbinds a key with null', () => {
    const report = resolveBindings(file(['chat', { 'ctrl+e': 'editor.lineEnd', 'ctrl+s': 'history.search', 'ctrl+r': null }]));
    expect(rejections(report)).toEqual([]);
    expect(keysOf(report, 'history.search')).toEqual(['ctrl+s']);
    expect(keysOf(report, 'editor.lineEnd')).toEqual(['ctrl+e', 'end']);
  });

  it('gives a key a default uses to the action the file names, and the displaced action keeps its other keys', () => {
    const report = resolveBindings(file(['chat', { 'ctrl+a': 'editor.lineEnd' }]));
    expect(rejections(report)).toEqual([]);
    expect(keysOf(report, 'editor.lineEnd')).toEqual(['ctrl+a', 'ctrl+e', 'end']);
    expect(keysOf(report, 'editor.lineStart')).toEqual(['home']);
  });

  it('rejects an entry that would leave the displaced action with no key', () => {
    const report = resolveBindings(file(['chat', { 'ctrl+k': 'editor.yank' }]));
    expect(rejections(report)).toEqual(['chat ctrl+k: editor.killLineEnd would have no key']);
    expect(report.rows).toEqual(KEYS);
  });

  it('lets null leave an action with no key, except the two deciding keys of a list', () => {
    const report = resolveBindings(file(['chat', { 'ctrl+k': null }], ['select', { escape: null }]));
    expect(rejections(report)).toEqual(['select escape: select.escape would have no key']);
    expect(keysOf(report, 'editor.killLineEnd')).toEqual([]);
    expect(keysOf(report, 'select.escape')).toEqual(['escape']);
    expect(rejections(resolveBindings(file(['select', { enter: null }])))).toEqual(['select enter: select.decide would have no key']);
  });

  it('keeps Enter on the pair that shares it in chat, submit when idle and steer while a run works, until a binding parts them', () => {
    const untouched = resolveBindings(file());
    expect(rejections(untouched)).toEqual([]);
    expect([keysOf(untouched, 'prompt.submit'), keysOf(untouched, 'prompt.steer'), keysOf(untouched, 'prompt.queue')]).toEqual([['enter'], ['enter'], ['tab']]);
    const parted = resolveBindings(file(['chat', { 'ctrl+s': 'prompt.steer', enter: 'prompt.submit' }]));
    expect(rejections(parted)).toEqual([]);
    expect([keysOf(parted, 'prompt.submit'), keysOf(parted, 'prompt.steer'), keysOf(parted, 'prompt.queue')]).toEqual([['enter'], ['ctrl+s'], ['tab']]);
    expect(rejections(resolveBindings(file(['chat', { tab: 'prompt.steer' }])))).toEqual(['chat tab: prompt.queue would have no key']);
  });

  it('lets queue take Enter as the Enter of the busy state: submit keeps it, and steer gives it up', () => {
    const swapped = resolveBindings(file(['chat', { enter: 'prompt.queue', tab: 'prompt.steer' }]));
    expect(rejections(swapped)).toEqual([]);
    expect([keysOf(swapped, 'prompt.submit'), keysOf(swapped, 'prompt.queue'), keysOf(swapped, 'prompt.steer')]).toEqual([['enter'], ['enter'], ['tab']]);
    const both = resolveBindings(file(['chat', { enter: 'prompt.queue', 'ctrl+s': 'prompt.steer' }]));
    expect(rejections(both)).toEqual([]);
    expect([keysOf(both, 'prompt.submit'), keysOf(both, 'prompt.queue'), keysOf(both, 'prompt.steer')]).toEqual([['enter'], ['enter', 'tab'], ['ctrl+s']]);
  });

  it('never leaves prompt.submit without a key', () => {
    expect(rejections(resolveBindings(file(['chat', { enter: null }])))).toEqual(['chat enter: prompt.submit would have no key']);
    expect(keysOf(resolveBindings(file(['chat', { enter: null }])), 'prompt.submit')).toEqual(['enter']);
  });

  it.each<[string, [string, Record<string, string | null>], string]>([
    ['an unknown context', ['editor', { 'ctrl+e': 'editor.lineEnd' }], 'editor ctrl+e: unknown context editor'],
    ['an unknown action', ['chat', { 'ctrl+e': 'editor.fly' }], 'chat ctrl+e: unknown action editor.fly'],
    ['an action of another context', ['chat', { 'ctrl+e': 'select.up' }], 'chat ctrl+e: select.up belongs to the context select'],
    ['a key that cannot be read', ['chat', { 'fn+e': 'editor.lineEnd' }], 'chat fn+e: cannot read the key fn+e'],
    ['a reserved key', ['chat', { 'ctrl+c': 'editor.lineEnd' }], 'chat ctrl+c: ctrl+c is reserved'],
    ['a reserved key unbound', ['chat', { 'ctrl+d': null }], 'chat ctrl+d: ctrl+d is reserved'],
    ['a reserved key inside a chord', ['chat', { 'ctrl+x ctrl+z': 'editor.undo' }], 'chat ctrl+x ctrl+z: ctrl+x ctrl+z is reserved'],
    ['a plain character where text is typed', ['chat', { x: 'editor.undo' }], 'chat x: x is text in the context chat'],
  ])('rejects %s with its reason and applies the other entries', (_name, [context, bindings], reason) => {
    const report = resolveBindings(file([context, bindings], ['chat', { 'ctrl+s': 'history.search' }]));
    expect(rejections(report)).toEqual([reason]);
    expect(keysOf(report, 'history.search')).toEqual(['ctrl+s', 'ctrl+r']);
  });

  it('accepts a plain character in a list, where nothing is typed', () => {
    const report = resolveBindings(file(['select', { g: 'select.first' }]));
    expect(rejections(report)).toEqual([]);
    expect(keysOf(report, 'select.first')).toEqual(['g', 'home']);
  });

  it('rejects both entries that bind one key of one context to two actions, also under two spellings', () => {
    const report = resolveBindings(file(['chat', { 'alt+s': 'history.search' }], ['chat', { 'opt+s': 'editor.undo' }]));
    expect(rejections(report)).toEqual(['chat alt+s: alt+s is bound twice in the context chat', 'chat opt+s: opt+s is bound twice in the context chat']);
    expect(report.rows).toEqual(KEYS);
  });

  it('keeps one key bound in two contexts apart', () => {
    const report = resolveBindings(file(['chat', { 'alt+s': 'history.search' }], ['select', { 'alt+s': 'select.first' }]));
    expect(rejections(report)).toEqual([]);
  });

  it('rejects a single key and a chord that starts with it in one context, both', () => {
    const report = resolveBindings(file(['chat', { 'ctrl+x': 'editor.undo', 'ctrl+x enter': 'prompt.submit' }]));
    expect(rejections(report)).toEqual(['chat ctrl+x: ctrl+x is both a key and the start of a chord in the context chat', 'chat ctrl+x enter: ctrl+x enter is both a key and the start of a chord in the context chat']);
  });

  it('rejects a chord whose first key a default still uses, and accepts it once that key is unbound', () => {
    expect(rejections(resolveBindings(file(['chat', { 'ctrl+k x': 'editor.undo' }])))).toEqual(['chat ctrl+k x: ctrl+k x is both a key and the start of a chord in the context chat']);
    const freed = resolveBindings(file(['chat', { 'ctrl+k': null, 'ctrl+k x': 'editor.undo' }]));
    expect(rejections(freed)).toEqual([]);
    expect(keysOf(freed, 'editor.undo')).toEqual(['ctrl+k x', 'ctrl+_']);
  });

  it.each([null, 7, 'x', [], {}, { bindings: {} }, { bindings: [7] }, { bindings: [{ context: 'chat' }] }, { bindings: [{ context: 'chat', bindings: { 'ctrl+e': 7 } }] }])('refuses the value %j as a whole and keeps the defaults', (value) => {
    const report = resolveBindings(value);
    expect(report.rows).toEqual(KEYS);
    expect(report.fileProblem).toBe('the file must be { "bindings": [ { "context": "<context>", "bindings": { "<key>": "<action>" } } ] }');
  });

  it('never throws and never leaves two actions of one context on one key, for any generated file (P12)', () => {
    const random = seeded(16);
    const contexts = ['chat', 'select', 'menu', 'viewer', 'nowhere'];
    const keys = ['ctrl+k', 'ctrl+e', 'ctrl+x', 'ctrl+x enter', 'ctrl+x ctrl+k', 'escape', 'enter', 'ctrl+c', 'k', 'alt+s', 'fn+q', 'up'];
    const actions = [...KEYS.map((row) => row.id), 'nothing.here', null];
    const pick = <T,>(from: readonly T[]): T => from[Math.floor(random() * from.length)] as T;
    for (let round = 0; round < 300; round += 1) {
      const blocks = Array.from({ length: 1 + Math.floor(random() * 3) }, (): [string, Record<string, string | null>] => [pick(contexts), Object.fromEntries(Array.from({ length: Math.floor(random() * 5) }, () => [pick(keys), pick(actions)]))]);
      const report = resolveBindings(file(...blocks));
      for (const context of new Set(report.rows.map((row) => row.context))) {
        const inContext = report.rows.filter((row) => row.context === context);
        const inForce = inContext.flatMap((row) => [...row.default]);
        for (const key of new Set(inForce)) {
          const holders = inContext.filter((row) => row.default.includes(key)).map((row) => row.id);
          if (holders.length > 1) expect(KEYS.filter((row) => row.context === context && (row.default as readonly string[]).includes(key)).map((row) => row.id)).toEqual(expect.arrayContaining(holders));
        }
        for (const key of inForce) expect(inForce.some((other) => other !== key && other.startsWith(`${key} `))).toBe(false);
      }
      for (const id of ['select.decide', 'select.escape'] as const) expect(keysOf(report, id).length).toBeGreaterThan(0);
      for (const entry of report.entries) if (entry.rejected === undefined && entry.action !== null) expect(keysOf(report, entry.action as ActionId)).toContain(entry.spec);
    }
  });
});

describe('the text of a key-binding file', () => {
  it('is read into a document', () => {
    expect(parseKeyFile('{"bindings":[],"$schema":"x"}')).toEqual({ kind: 'document', document: { bindings: [], $schema: 'x' } });
  });

  it('is refused when it is not JSON, with the position the parser reports', () => {
    const refused = parseKeyFile('{"bindings": [');
    expect(refused.kind).toBe('refused');
    expect(refused).toMatchObject({ reason: expect.stringMatching(/^not valid JSON: .+/) });
  });

  it('refuses a file nested deeper than the one JSON depth limit', () => {
    const deep = `{"bindings":${'['.repeat(200)}${']'.repeat(200)}}`;
    expect(parseKeyFile(deep)).toEqual({ kind: 'refused', reason: 'JSON depth exceeds the limit of 128' });
  });

  it('is refused when it has another shape', () => {
    expect(parseKeyFile('[]')).toEqual({ kind: 'refused', reason: 'the file must be { "bindings": [ { "context": "<context>", "bindings": { "<key>": "<action>" } } ] }' });
  });

  it('is refused above 64 KiB and read at exactly 64 KiB', () => {
    const padded = (bytes: number): string => {
      const empty = '{"bindings":[],"pad":""}';
      return `{"bindings":[],"pad":"${'x'.repeat(bytes - empty.length)}"}`;
    };
    expect(parseKeyFile(padded(KEY_FILE_MAX_BYTES)).kind).toBe('document');
    expect(parseKeyFile(padded(KEY_FILE_MAX_BYTES + 1))).toEqual({ kind: 'refused', reason: 'the file is larger than 64 KiB' });
  });
});

describe('a change written from inside the TUI', () => {
  const row = (id: ActionId) => KEYS.find((candidate) => candidate.id === id) as (typeof KEYS)[number];

  it('adds the binding to the block of its context and keeps every other top-level key', () => {
    const before = { $schema: 'x', bindings: [{ context: 'select', bindings: { g: 'select.first' } }] };
    expect(withBinding(before, 'chat', 'ctrl+s', 'history.search')).toEqual({ $schema: 'x', bindings: [{ context: 'select', bindings: { g: 'select.first' } }, { context: 'chat', bindings: { 'ctrl+s': 'history.search' } }] });
    expect(withBinding(file(['chat', { 'Ctrl+S': 'editor.undo' }]), 'chat', 'ctrl+s', 'history.search')).toEqual(file(['chat', { 'ctrl+s': 'history.search' }]));
  });

  it('removes the keys of an action: its entries go and each default key in force is unbound', () => {
    const before = file(['chat', { 'ctrl+s': 'history.search', 'ctrl+e': 'editor.lineEnd' }]);
    const after = withoutKeysOf(before, row('history.search'), ['ctrl+s', 'ctrl+r']);
    expect(after).toEqual(file(['chat', { 'ctrl+e': 'editor.lineEnd', 'ctrl+r': null }]));
    expect(resolveBindings(after).rows.find((found) => found.id === 'history.search')?.default).toEqual([]);
  });

  it('resets one action: its entries and the unbinding of its default keys go', () => {
    const before = file(['chat', { 'ctrl+s': 'history.search', 'ctrl+r': null, 'ctrl+e': 'editor.lineEnd' }]);
    expect(withDefaultsOf(before, row('history.search'))).toEqual(file(['chat', { 'ctrl+e': 'editor.lineEnd' }]));
  });

  it('resets all and keeps the other top-level keys', () => {
    expect(withAllDefaults({ $schema: 'x', bindings: [{ context: 'chat', bindings: { 'ctrl+s': 'history.search' } }] })).toEqual({ $schema: 'x', bindings: [] });
  });

  it('is written as indented JSON with a final newline', () => {
    expect(keyDocumentText({ bindings: [] })).toBe('{\n  "bindings": []\n}\n');
  });
});

describe('the capture of a new key', () => {
  it('names the two keys that do not bind in its row', () => {
    expect(captureTitle('history.search')).toBe('Press the new key for history.search (esc cancels, backspace removes the keys)');
  });

  it('takes the key as the terminal reports it, cancels on esc, removes on backspace and names a reserved key', () => {
    expect(capturedOf(text('s', { ctrl: true }))).toEqual({ kind: 'key', spec: 'ctrl+s' });
    expect(capturedOf(named('f5'))).toEqual({ kind: 'key', spec: 'f5' });
    expect(capturedOf(text('g'))).toEqual({ kind: 'key', spec: 'g' });
    expect(capturedOf(named('escape'))).toEqual({ kind: 'cancel' });
    expect(capturedOf(named('backspace'))).toEqual({ kind: 'remove' });
    expect(capturedOf(text('c', { ctrl: true }))).toEqual({ kind: 'refused', reason: 'ctrl+c is reserved' });
  });
});

describe('a table built from a file', () => {
  const tableOf = (...blocks: [string, Record<string, string | null>][]) => createKeyTable(resolveBindings(file(...blocks)).rows);

  it('acts on the rebound key and not on the old one', () => {
    const table = tableOf(['chat', { 'ctrl+s': 'history.search', 'ctrl+r': null }]);
    expect(table.actionOf(['chat'], text('s', { ctrl: true }))).toBe('history.search');
    expect(table.actionOf(['chat'], text('r', { ctrl: true }))).toBeUndefined();
    expect(table.hintFor('history.search')).toBe('ctrl+s');
    expect(table.keyHint('history.search')).toBe('ctrl+s');
  });

  it('names no key in the hint of an action that has none', () => {
    const table = tableOf(['chat', { 'ctrl+r': null }]);
    expect(table.hintFor('history.search')).toBe('');
    expect(table.keyHint('history.search')).toBe('');
  });

  it('reads a plain character as a key only where the caller asks for it', () => {
    expect(DEFAULT_KEY_TABLE.actionOf(['select'], text('k'))).toBeUndefined();
    expect(DEFAULT_KEY_TABLE.actionOf(['select'], text('k'), 'plain')).toBe('select.up');
    expect(DEFAULT_KEY_TABLE.typedOf(text('k'))).toBe('k');
    expect(DEFAULT_KEY_TABLE.typedOf(text('k', { ctrl: true }))).toBeUndefined();
    expect(DEFAULT_KEY_TABLE.typedOf(named('enter'))).toBeUndefined();
  });

  it('holds a chord across its keys with no timer and drops a key that does not continue it', () => {
    const table = tableOf(['chat', { 'ctrl+x enter': 'prompt.submit', 'ctrl+x ctrl+s': 'history.search' }]);
    const contexts: KeyContext[] = ['chat', 'global'];
    expect(table.chordStep(contexts, undefined, text('a', { ctrl: true }))).toEqual({ kind: 'none' });
    expect(table.chordStep(contexts, undefined, text('x', { ctrl: true }))).toEqual({ kind: 'pending', prefix: 'ctrl+x' });
    expect(table.chordStep(contexts, 'ctrl+x', named('enter'))).toEqual({ kind: 'action', id: 'prompt.submit' });
    expect(table.chordStep(contexts, 'ctrl+x', text('s', { ctrl: true }))).toEqual({ kind: 'action', id: 'history.search' });
    expect(table.chordStep(contexts, 'ctrl+x', text('q'))).toEqual({ kind: 'dropped' });
    expect(table.chordStep(['viewer'], undefined, text('x', { ctrl: true }))).toEqual({ kind: 'none' });
    const pressed = chordPressOf(table, 'prompt.submit');
    expect(pressed.actionOf(['chat'], named('enter'))).toBe('prompt.submit');
    expect(pressed.actionOf(['select'], named('enter'))).toBeUndefined();
    expect(pressed.typedOf(text('q'))).toBeUndefined();
  });

  it('knows which keys a terminal reports only with the keyboard protocol', () => {
    for (const key of ['shift+enter', 'ctrl+enter', 'ctrl+shift+k', 'cmd+k', 'hyper+k', 'cmd+enter', 'ctrl+x cmd+k']) expect(needsReport(key)).toBe(true);
    for (const key of ['ctrl+k', 'shift+tab', 'alt+enter', 'enter', 'f5']) expect(needsReport(key)).toBe(false);
    expect(keyReported('shift+enter', 'unknown')).toBe(false);
    expect(keyReported('shift+enter', 'kitty')).toBe(true);
    for (const state of ['unknown', 'plain', 'modify-other-keys'] as const) expect(keyReported('cmd+k', state)).toBe(false);
    for (const state of ['kitty', 'proven'] as const) expect(keyReported('cmd+k', state)).toBe(true);
    expect(keyReported('hyper+k', 'kitty')).toBe(true);
    expect(keyReported('ctrl+j', 'unknown')).toBe(true);
  });

  it('names the newline key that works in the state of the terminal, from the keys in force', () => {
    expect(newlineKeyHint(DEFAULT_KEY_TABLE, 'unknown')).toBe('ctrl+j');
    expect(newlineKeyHint(DEFAULT_KEY_TABLE, 'kitty')).toBe('shift+enter');
    const rebound = tableOf(['chat', { 'ctrl+n': 'prompt.newline', 'ctrl+j': null }]);
    expect(newlineKeyHint(rebound, 'unknown')).toBe('ctrl+n');
    expect(newlineKeyHint(tableOf(['chat', { 'ctrl+j': null }]), 'unknown')).toBe('');
  });
});

describe('the key-binding file on disk', () => {
  const FILE = '/home/u/.momonga/keybindings.json';
  const SHOWN = '~/.momonga/keybindings.json';

  const disk = (initial?: string) => {
    let content = initial;
    let mtimeMs = 1;
    const written: { file: string; text: string; mode: number }[] = [];
    const stats: string[] = [];
    const files: KeyFiles = {
      stat: async (file) => {
        stats.push(file);
        return content === undefined ? undefined : { mtimeMs, size: Buffer.byteLength(content) };
      },
      read: async () => {
        if (content === undefined) throw new Error('no file');
        return content;
      },
      write: async (file, text, mode) => {
        written.push({ file, text, mode });
        content = text;
        mtimeMs += 1;
      },
    };
    return {
      files,
      written,
      stats,
      edit: (text: string | undefined) => {
        content = text;
        mtimeMs += 1;
      },
    };
  };

  const opened = async (initial?: string) => {
    const host = disk(initial);
    const notices: string[] = [];
    const store = createKeyBindings({ file: FILE, shownFile: SHOWN, files: host.files });
    await store.load();
    store.listen((notice) => notices.push(notice));
    return { ...host, store, notices };
  };

  const turns = async (): Promise<void> => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  };

  const settled = async (met: () => boolean): Promise<void> => {
    for (let turn = 0; turn < 50 && !met(); turn += 1) await Promise.resolve();
    expect(met()).toBe(true);
    await turns();
  };

  it('has the defaults and no notice when there is no file', async () => {
    const { store, notices } = await opened();
    expect(store.report()).toEqual({ rows: KEYS, entries: [] });
    expect(notices).toEqual([]);
  });

  it('applies the file at startup and names the count of ignored entries in one notice', async () => {
    const { store, notices } = await opened(JSON.stringify(file(['chat', { 'ctrl+s': 'history.search', 'ctrl+c': 'editor.undo', 'fn+x': 'editor.undo' }])));
    expect(store.table().keysFor('history.search')).toEqual(['ctrl+s', 'ctrl+r']);
    expect(notices).toEqual(['2 key bindings in ~/.momonga/keybindings.json were ignored; /keybindings shows why']);
  });

  it('says one ignored entry in the singular', () => {
    expect(ignoredNotice(resolveBindings(file(['chat', { 'ctrl+c': 'editor.undo' }])), SHOWN)).toBe('1 key binding in ~/.momonga/keybindings.json was ignored; /keybindings shows why');
  });

  it('ignores a file that is not JSON as a whole, with the reason in the notice', async () => {
    const { store, notices } = await opened('{"bindings": [');
    expect(store.report().rows).toEqual(KEYS);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^~\/\.momonga\/keybindings\.json was ignored \(not valid JSON: .+\); \/keybindings shows why$/);
  });

  it('reads the file again when its time or size changed, at most one stat per second, and keeps the previous good table on a bad file', async () => {
    const { store, edit, stats, notices } = await opened(JSON.stringify(file(['chat', { 'ctrl+s': 'history.search' }])));
    const tables: unknown[] = [];
    store.subscribe(() => tables.push(store.table()));
    const statsAfterLoad = stats.length;
    edit(JSON.stringify(file(['chat', { 'alt+s': 'history.search' }])));
    store.poll(10_000);
    await settled(() => store.table().keysFor('history.search').includes('alt+s'));
    expect(store.table().keysFor('history.search')).toEqual(['alt+s', 'ctrl+r']);
    expect(tables).toHaveLength(1);
    store.poll(10_000 + KEY_FILE_STAT_MS - 1);
    expect(stats.length).toBe(statsAfterLoad + 1);
    edit('{"bindings": [');
    store.poll(10_000 + KEY_FILE_STAT_MS);
    await settled(() => notices.length === 1);
    expect(notices[0]).toMatch(/was ignored \(not valid JSON/);
    expect(store.table().keysFor('history.search')).toEqual(['alt+s', 'ctrl+r']);
    expect(store.report().fileProblem).toMatch(/^not valid JSON/);
    edit(undefined);
    store.poll(10_000 + 2 * KEY_FILE_STAT_MS);
    await settled(() => store.report().fileProblem === undefined);
    expect(store.report().rows).toEqual(KEYS);
  });

  it('applies a poll that arrives while a reload is under way, after that reload', async () => {
    const { store, edit, files, stats } = await opened(JSON.stringify(file()));
    const gate = Promise.withResolvers<void>();
    const stat = files.stat;
    files.stat = async (asked) => {
      const found = await stat(asked);
      await gate.promise;
      return found;
    };
    store.poll(10_000);
    edit(JSON.stringify(file(['chat', { 'alt+s': 'history.search' }])));
    store.poll(10_000 + KEY_FILE_STAT_MS);
    const statsWhileReading = stats.length;
    gate.resolve();
    await settled(() => store.table().keysFor('history.search').includes('alt+s'));
    expect(stats.length).toBe(statsWhileReading + 1);
  });

  it('does not read a file that did not change', async () => {
    const { store, stats } = await opened(JSON.stringify(file()));
    const tables: unknown[] = [];
    store.subscribe(() => tables.push(store.table()));
    store.poll(5000);
    await settled(() => stats.length === 2);
    expect(tables).toEqual([]);
  });

  it('writes a change at once with mode 0600, applies it, and does not read its own write again', async () => {
    const { store, written, notices } = await opened('{"$schema":"x","bindings":[]}');
    const tables: unknown[] = [];
    store.subscribe(() => tables.push(store.table()));
    const report = await store.change((document) => withBinding(document, 'chat', 'ctrl+s', 'history.search'));
    expect(written).toEqual([{ file: FILE, text: `${JSON.stringify({ $schema: 'x', bindings: [{ context: 'chat', bindings: { 'ctrl+s': 'history.search' } }] }, null, 2)}\n`, mode: KEY_FILE_MODE }]);
    expect(KEY_FILE_MODE).toBe(0o600);
    expect(keysOf(report, 'history.search')).toEqual(['ctrl+s', 'ctrl+r']);
    expect(store.table().actionOf(['chat'], text('s', { ctrl: true }))).toBe('history.search');
    expect(tables).toHaveLength(1);
    store.poll(99_000);
    await turns();
    expect(tables).toHaveLength(1);
    expect(notices).toEqual([]);
  });

  it('shows what a change would do without writing it', async () => {
    const { store, written } = await opened();
    expect(rejections(store.preview((document) => withBinding(document, 'chat', 'ctrl+k', 'editor.yank')))).toEqual(['chat ctrl+k: editor.killLineEnd would have no key']);
    expect(written).toEqual([]);
    expect(store.report().rows).toEqual(KEYS);
  });

  it('refuses to write over a file it could not read', async () => {
    const { store, written } = await opened('{"bindings": [');
    await expect(store.change((document) => document)).rejects.toThrow(/^~\/\.momonga\/keybindings\.json cannot be changed here \(not valid JSON: .+\); correct or remove the file first$/);
    expect(written).toEqual([]);
  });
});
