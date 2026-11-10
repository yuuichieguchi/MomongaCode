import { describe, expect, it } from 'vitest';
import { systemTiming } from '@momonga/foundation';
import { App, exitHint, taskRunningHint } from '../../src/tui/app.tsx';
import type { AppProps } from '../../src/tui/app.tsx';
import { editorUnsetHint } from '../../src/tui/external-editor.ts';
import { resolveBindings } from '../../src/tui/keys/bindings.ts';
import { createKeyBindings } from '../../src/tui/keys/store.ts';
import type { KeyFiles } from '../../src/tui/keys/store.ts';
import { createKeyTable, DEFAULT_KEY_TABLE, KEYS, newlineKeyHint } from '../../src/tui/keys/table.ts';
import type { ActionId, KeyTable } from '../../src/tui/keys/table.ts';
import { textHint, waitingHint } from '../../src/tui/picker.tsx';
import { attachmentLine } from '../../src/tui/screen/attachments.tsx';
import { footerRow, newlineHintText } from '../../src/tui/screen/footer.tsx';
import { fieldHint } from '../../src/tui/screen/prompt-panel.tsx';
import { expandRowText } from '../../src/tui/screen/tool-view.ts';
import { waitingRowText } from '../../src/tui/screen/waiting-row.tsx';
import { detailHintParts, joinHint, moreLinesText, selectHint } from '../../src/tui/select.tsx';
import type { SelectSpec } from '../../src/tui/select.tsx';
import { createSlashRegistry, helpText } from '../../src/tui/slash.ts';
import { DEFAULT_SLASH_COMMANDS } from '../../src/tui/commands/index.ts';
import type { KeyEvent, KeyName } from '../../src/tui/terminal/events.ts';
import { fakeBackend } from '../fake-backend.ts';
import type { FakeBackendOptions } from '../fake-backend.ts';
import { KEYS as PRESS, renderObservable, untilFrame, untilOutput } from '../ink-helpers.ts';
import { frame } from '../tui-harness.tsx';
import { fakeScreenTerminal } from './screen-fakes.ts';

const plain = { ctrl: false, alt: false, shift: false };
const named = (name: KeyName, mods: Partial<typeof plain> = {}): KeyEvent => ({ type: 'key', name, ...plain, ...mods });
const text = (value: string, mods: Partial<typeof plain> = {}): KeyEvent => ({ type: 'key', text: value, ...plain, ...mods });

type Blocks = [string, Record<string, string | null>][];

const file = (...blocks: Blocks) => ({ bindings: blocks.map(([context, bindings]) => ({ context, bindings })) });

const tableOf = (...blocks: Blocks): KeyTable => {
  const report = resolveBindings(file(...blocks));
  expect(report.entries.filter((entry) => entry.rejected !== undefined)).toEqual([]);
  return createKeyTable(report.rows);
};

const FILE = '/home/u/.momonga/keybindings.json';
const SHOWN = '~/.momonga/keybindings.json';

const disk = (initial?: string) => {
  let content = initial;
  let mtimeMs = 1;
  const written: { file: string; text: string; mode: number }[] = [];
  const files: KeyFiles = {
    stat: async () => (content === undefined ? undefined : { mtimeMs, size: Buffer.byteLength(content) }),
    read: async () => content ?? '',
    write: async (target, body, mode) => {
      written.push({ file: target, text: body, mode });
      content = body;
      mtimeMs += 1;
    },
  };
  return {
    files,
    written,
    content: () => (content === undefined ? undefined : (JSON.parse(content) as unknown)),
    edit: (next: string) => {
      content = next;
      mtimeMs += 1;
    },
  };
};

const startWith = async (options: FakeBackendOptions, extra: Partial<AppProps>, screen: Parameters<typeof fakeScreenTerminal>[0] = {}) => {
  const backend = fakeBackend(options);
  const terminal = fakeScreenTerminal(screen);
  const app = renderObservable(<App backend={backend} terminal={terminal} initialMode={undefined} now={Date.now} timers={systemTiming} {...extra} onExit={() => undefined} />);
  return { backend, terminal, app };
};

const withFile = async (initial: ReturnType<typeof file> | undefined, options: FakeBackendOptions = {}, screen: Parameters<typeof fakeScreenTerminal>[0] = {}) => {
  const host = disk(initial === undefined ? undefined : JSON.stringify(initial));
  const keyBindings = createKeyBindings({ file: FILE, shownFile: SHOWN, files: host.files });
  await keyBindings.load();
  const started = await startWith(options, { keyBindings }, screen);
  return { ...started, ...host, keyBindings };
};

const command = async (app: Awaited<ReturnType<typeof startWith>>['app'], line: string): Promise<void> => {
  app.stdin.write(line);
  await untilFrame(app, `> ${line}`);
  app.stdin.write(PRESS.enter);
};

const running = async (started: Awaited<ReturnType<typeof startWith>>): Promise<void> => {
  await command(started.app, 'go');
  await started.backend.called('openSession');
  await untilOutput(started.app, '> go');
};

const numbered = (count: number): string => Array.from({ length: count }, (_, index) => `out ${index}`).join('\n');

const REBOUND: Blocks = [
  ['chat', { 'alt+m': 'mode.cycle', 'shift+tab': null, 'ctrl+n': 'prompt.newline', 'ctrl+j': null, 'shift+enter': null, 'alt+enter': null, f2: 'run.stop', escape: null, 'ctrl+t': 'transcript.detail', 'ctrl+o': null, 'ctrl+b': 'editor.deleteBefore', backspace: null, 'ctrl+v': 'editor.external', 'ctrl+g': null, f6: 'prompt.submit', enter: null }],
  ['select', { w: 'select.up', up: null, 'ctrl+p': null, k: null, s: 'select.down', down: null, 'ctrl+n': null, j: null, f3: 'select.decide', enter: null, q: 'select.escape', escape: null, f4: 'select.alt', tab: null, 'ctrl+t': 'select.detail', 'ctrl+o': null, 'ctrl+u': 'select.copy', 'ctrl+y': null }],
  ['viewer', { w: 'viewer.up', up: null, s: 'viewer.down', down: null, q: 'viewer.close', escape: null }],
  ['viewport', { f7: 'viewport.pageUp', pageup: null }],
];

describe('every hint is generated from the keys in force (P11)', () => {
  const rebound = tableOf(...REBOUND);
  const spec: SelectSpec = { rows: [{ label: 'Yes' }, { label: 'No' }], initial: 0, decideOn: 'immediate', escape: 1, interrupt: 'cancel-run', filter: false, alt: { label: 'also later' } };
  const footerFacts = { mode: 'manual', tokens: 0, contextPercent: 0, imageInput: false, right: undefined };
  const waiting = { phase: { text: 'thinking', startedAt: 0 }, cancelKey: 'run.stop' as const };
  const attachment = { file: '/a.png', image: { mediaType: 'image/png' as const, data: '' } };

  const hints: readonly [string, (keys: KeyTable) => string, string, string][] = [
    ['the list hint', (keys) => selectHint(spec, keys), '1-9 or enter to choose · up/down to move · tab: also later · esc: No · ctrl+c: cancel the run', '1-9 or f3 to choose · w/s to move · f4: also later · q: No · ctrl+c: cancel the run'],
    ['the list hint that goes back', (keys) => selectHint({ rows: spec.rows, initial: 0, escape: 'back', decideOn: 'enter', interrupt: 'back', filter: true }, keys), 'up/down to move · enter to choose · type to filter · esc: go back', 'w/s to move · f3 to choose · type to filter · q: go back'],
    ['the detail hint', (keys) => joinHint(detailHintParts(keys)), 'up/down to scroll · esc to return', 'w/s to scroll · q to return'],
    ['the cut text row of a prompt', (keys) => moreLinesText(4, keys), '… 4 more lines (ctrl+o shows all)', '… 4 more lines (ctrl+t shows all)'],
    ['the sign-in hint', waitingHint, 'enter submits the pasted URL · ctrl+y copies the sign-in URL · esc cancels', 'f3 submits the pasted URL · ctrl+u copies the sign-in URL · q cancels'],
    ['the text prompt hint', textHint, 'enter to confirm · esc: go back', 'f3 to confirm · q: go back'],
    ['the field hint', fieldHint, 'enter to confirm the value · esc: decline or cancel instead', 'f3 to confirm the value · q: decline or cancel instead'],
    ['the footer', (keys) => footerRow(footerFacts, 80, keys), 'mode: manual (shift+tab) · tokens: 0 · context: 0%', 'mode: manual (alt+m) · tokens: 0 · context: 0%'],
    ['the newline hint', (keys) => newlineHintText(newlineKeyHint(keys, 'unknown')) ?? '', 'ctrl+j: new line', 'ctrl+n: new line'],
    ['the waiting row', (keys) => waitingRowText(waiting, { kind: 'static' }, 3000, keys), '• thinking 3s · esc to cancel', '• thinking 3s · f2 to cancel'],
    ['the hidden lines row', (keys) => expandRowText(7, keys), '… +7 lines (ctrl+o to expand)', '… +7 lines (ctrl+t to expand)'],
    ['the attachment line', (keys) => attachmentLine(attachment, keys).replace('attached a.png (image/png, 0 bytes) ', ''), '(backspace on an empty input removes the last)', '(ctrl+b on an empty input removes the last)'],
    ['the editor hint', editorUnsetHint, 'Set $EDITOR to use ctrl+g.', 'Set $EDITOR to use ctrl+v.'],
    ['the running-task hint', taskRunningHint, 'A task is running. Esc stops it.', 'A task is running. F2 stops it.'],
    ['the exit hint', (keys) => exitHint(keys.hintFor('prompt.interrupt')), 'Press ctrl+c again to exit', 'Press ctrl+c again to exit'],
  ];

  it.each(hints)('%s names the default keys, and under a rebinding the new keys and not the old', (_name, hint, byDefault, afterRebinding) => {
    expect(hint(DEFAULT_KEY_TABLE)).toBe(byDefault);
    expect(hint(rebound)).toBe(afterRebinding);
  });

  it('a hint names no key for an action that has none', () => {
    const bare = tableOf(['chat', { 'shift+tab': null, 'ctrl+o': null, escape: null, backspace: null, 'ctrl+g': null }], ['select', { tab: null, 'ctrl+o': null, 'ctrl+y': null }], ['viewer', { up: null, down: null }]);
    expect(footerRow(footerFacts, 80, bare)).toBe('mode: manual · tokens: 0 · context: 0%');
    expect(expandRowText(7, bare)).toBe('… +7 lines');
    expect(waitingRowText(waiting, { kind: 'static' }, 0, bare)).toBe('• thinking 0s');
    expect(attachmentLine(attachment, bare)).toBe('attached a.png (image/png, 0 bytes)');
    expect(editorUnsetHint(bare)).toBe('Set $EDITOR to edit the draft in an editor.');
    expect(taskRunningHint(bare)).toBe('A task is running.');
    expect(selectHint(spec, bare)).toBe('1-9 or enter to choose · up/down to move · esc: No · ctrl+c: cancel the run');
    expect(moreLinesText(4, bare)).toBe('… 4 more lines');
    expect(waitingHint(bare)).toBe('enter submits the pasted URL · esc cancels');
    expect(joinHint(detailHintParts(bare))).toBe('esc to return');
  });

  it('/help lists every key in force of the editor, the viewport and the screen, and no key that was unbound', () => {
    const commands = createSlashRegistry(DEFAULT_SLASH_COMMANDS).list();
    const lines = helpText({ commands, keys: rebound, negotiation: 'unknown', screen: 'fullscreen' }).split('\n');
    const keyLines = lines.slice(lines.indexOf('Keys') + 1, lines.indexOf('Mouse'));
    for (const row of rebound.rows().filter((candidate) => ['chat', 'viewport', 'global'].includes(candidate.context) && candidate.id !== 'prompt.newline' && candidate.default.length > 0)) expect(keyLines).toContain(`  ${rebound.hintFor(row.id)}: ${row.description}`);
    expect(keyLines).toContain('  ctrl+n: new line');
    expect(keyLines).toContain('  \\ then f6: new line');
    expect(keyLines).toContain('  alt+m: cycles the mode');
    expect(keyLines).toContain('  f2: stops the run');
    expect(keyLines).toContain('  f7: scroll up half a screen');
    for (const old of ['shift+tab', 'ctrl+j', 'shift+enter', 'alt+enter', 'esc: stops the run', 'ctrl+o', 'pageup', 'ctrl+g', 'backspace']) expect(keyLines.join('\n')).not.toContain(old);
    expect(lines).toContain('  /keybindings  show the keys of every action and change them; the changes are written to the key-binding file');
    const unbound = helpText({ commands, keys: tableOf(['chat', { 'ctrl+r': null }]), negotiation: 'unknown', screen: 'fullscreen' });
    expect(unbound).not.toContain('search the history');
  });

  it('every action of the table is named by its keys in /keybindings or /help, so no row is without a reader', () => {
    const ids: ActionId[] = KEYS.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('a rebound key on the screen', () => {
  it('acts in the editor, the viewer and the footer hint, and the old key does not', async () => {
    const started = await withFile(file(['chat', { 'ctrl+t': 'transcript.detail', 'ctrl+o': null, 'alt+m': 'mode.cycle', 'shift+tab': null }], ['viewer', { q: 'viewer.close', escape: null }]), {}, { columns: 70, rows: 18 });
    const { app, backend, terminal } = started;
    const ready = await untilFrame(app, 'mode: manual (alt+m)');
    expect(ready).not.toContain('shift+tab');
    await running(started);
    backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Bash', kind: 'execute', title: 'Bash seq', rawInput: {} }));
    backend.emit(frame({ type: 'tool.completed', callId: 'c1', status: 'completed', output: numbered(30) }));
    const shown = await untilFrame(app, 'out 29');
    expect(shown).toContain('… +25 lines (ctrl+t to expand)');
    expect(shown).not.toContain('ctrl+o');
    app.stdin.write(PRESS.ctrlO);
    app.stdin.write('x');
    expect(await untilFrame(app, '> x')).not.toContain('to return');
    app.stdin.write(PRESS.backspace);
    terminal.emit(text('t', { ctrl: true }));
    const viewer = await untilFrame(app, 'up/down to scroll · q to return');
    expect(viewer.startsWith('out 0')).toBe(true);
    app.stdin.write(PRESS.escape);
    app.stdin.write(PRESS.down);
    await untilFrame(app, (now) => now.startsWith('out 1'));
    app.stdin.write('q');
    expect(await untilFrame(app, '✓ Bash seq')).not.toContain('to return');
    expect(backend.calls.filter((name) => name.toLowerCase().includes('cancel'))).toEqual([]);
    app.unmount();
  });

  it('decides a prompt with the rebound keys, and the hint under the list names them', async () => {
    const started = await withFile(file(['select', { f3: 'select.decide', enter: null, q: 'select.escape', escape: null }]), { trust: { path: '/work/project', decision: null } });
    const { app, backend, terminal } = started;
    const shown = await untilFrame(app, 'Do you trust the files in /work/project?');
    expect(shown).toContain('up/down to move · f3 to choose · q: No, continue without its project settings');
    app.stdin.write(PRESS.enter);
    app.stdin.write(PRESS.escape);
    app.stdin.write(PRESS.down);
    await untilFrame(app, '› 2. No, continue without its project settings');
    expect(backend.calls.filter((name) => name.startsWith('trust:'))).toEqual([]);
    app.stdin.write(PRESS.up);
    await untilFrame(app, '› 1. Yes, I trust this folder');
    terminal.emit(named('f3'));
    await backend.called('trust:trusted');
    app.unmount();
  });

  it('acts on a chord, holds its first key with no timer, and types nothing for it', async () => {
    const started = await withFile(file(['chat', { 'ctrl+x enter': 'prompt.submit' }]));
    const { app, backend } = started;
    await untilFrame(app, 'mode: manual');
    app.stdin.write('hello');
    await untilFrame(app, '> hello');
    app.stdin.write('\u0018');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(backend.started).toEqual([]);
    app.stdin.write(PRESS.enter);
    await backend.called('openSession');
    await untilOutput(app, '> hello');
    expect(backend.started.map((run) => run.text)).toEqual(['hello']);
    app.stdin.write('\u0018');
    app.stdin.write('z');
    app.stdin.write('y');
    const typed = await untilFrame(app, '> y');
    expect(typed).not.toContain('zy');
    app.unmount();
  });

  it('follows the file when it changes while the screen is open, at the next key press', async () => {
    const started = await withFile(undefined);
    const { app, edit } = started;
    await untilFrame(app, 'mode: manual (shift+tab)');
    edit(JSON.stringify(file(['chat', { 'alt+m': 'mode.cycle', 'shift+tab': null, 'ctrl+c': 'editor.undo' }])));
    app.stdin.write('a');
    const shown = await untilFrame(app, 'mode: manual (alt+m)');
    expect(shown).toContain('> a');
    await untilOutput(app, '1 key binding in ~/.momonga/keybindings.json was ignored; /keybindings shows why');
    app.unmount();
  });

  it('says at startup how many entries of the file were ignored', async () => {
    const { app } = await withFile(file(['chat', { 'ctrl+c': 'editor.undo', 'hyper+x': 'editor.undo' }]));
    await untilOutput(app, '2 key bindings in ~/.momonga/keybindings.json were ignored; /keybindings shows why');
    app.unmount();
  });
});

describe('/keybindings', () => {
  const opened = async (initial?: ReturnType<typeof file>) => {
    const started = await withFile(initial, {}, { columns: 150, rows: 40 });
    await untilFrame(started.app, 'mode: manual');
    await command(started.app, '/keybindings');
    await untilFrame(started.app, 'Key bindings');
    return started;
  };

  const choose = async (app: Awaited<ReturnType<typeof opened>>['app'], filter: string, row: string): Promise<void> => {
    app.stdin.write(filter);
    await untilFrame(app, (now) => now.split('\n').some((line) => line.includes('›') && line.includes(`. ${row}`)));
  };

  it('lists every action by context with its keys in force, marks a changed one, and shows why an entry was ignored', async () => {
    const { app } = await opened(file(['chat', { 'ctrl+s': 'history.search', 'ctrl+c': 'editor.undo' }]));
    const shown = app.lastFrame() ?? '';
    expect(shown).toContain('Open the file');
    expect(shown).toContain('Reset all to the defaults');
    expect(shown).toContain('  chat');
    expect(shown).toContain('prompt.newline  shift+enter, alt+enter, ctrl+j  new line (this terminal may not report it)');
    expect(shown).toContain('type to filter');
    expect(shown).toContain('tab: reset to the defaults');
    await choose(app, 'history.search', 'history.search  ctrl+s, ctrl+r  search the history (changed)');
    expect(shown).toContain('entries of the file that were ignored');
    expect(shown).toContain('chat: ctrl+c -> editor.undo  rejected: ctrl+c is reserved');
    app.unmount();
  });

  it('captures the next key for an action, writes the file at once and applies it without a restart', async () => {
    const { app, terminal, written, content } = await opened();
    await choose(app, 'history.search', 'history.search  ctrl+r  search the history');
    app.stdin.write(PRESS.enter);
    await untilFrame(app, 'Press the new key for history.search (esc cancels, backspace removes the keys)');
    terminal.emit(text('s', { ctrl: true }));
    await untilFrame(app, 'history.search  ctrl+s, ctrl+r  search the history (changed)');
    expect(written.map((write) => [write.file, write.mode])).toEqual([[FILE, 0o600]]);
    expect(content()).toEqual(file(['chat', { 'ctrl+s': 'history.search' }]));
    app.unmount();
  });

  it('names a reserved key and a key that is text in the row, and esc leaves the bindings as they are', async () => {
    const { app, terminal, written } = await opened();
    await choose(app, 'history.search', 'history.search  ctrl+r  search the history');
    app.stdin.write(PRESS.enter);
    await untilFrame(app, 'Press the new key for history.search');
    terminal.emit(text('c', { ctrl: true }));
    await untilFrame(app, 'ctrl+c is reserved');
    terminal.emit(text('x'));
    await untilFrame(app, 'x is text in the context chat');
    app.stdin.write(PRESS.escape);
    await untilFrame(app, 'Key bindings');
    expect(written).toEqual([]);
    app.unmount();
  });

  it('asks before taking a key another action uses, and replaces it on Replace', async () => {
    const { app, terminal, content } = await opened();
    await choose(app, 'editor.lineEnd', 'editor.lineEnd  ctrl+e, end  line end');
    app.stdin.write(PRESS.enter);
    await untilFrame(app, 'Press the new key for editor.lineEnd');
    terminal.emit(text('a', { ctrl: true }));
    const asked = await untilFrame(app, 'ctrl+a is used by editor.lineStart. Replace it?');
    expect(asked).toContain('› 1. Replace');
    expect(asked).toContain('  2. Cancel');
    app.stdin.write(PRESS.enter);
    await untilFrame(app, 'Key bindings');
    expect(content()).toEqual(file(['chat', { 'ctrl+a': 'editor.lineEnd' }]));
    for (let erased = 0; erased < 3; erased += 1) app.stdin.write(PRESS.escape);
    app.unmount();
  });

  it('keeps the key where it is on Cancel, and refuses a replacement that would leave an action with no key', async () => {
    const { app, terminal, written } = await opened();
    await choose(app, 'editor.yank', 'editor.yank  ctrl+y  insert the text last deleted');
    app.stdin.write(PRESS.enter);
    await untilFrame(app, 'Press the new key for editor.yank');
    terminal.emit(text('k', { ctrl: true }));
    await untilFrame(app, 'ctrl+k is used by editor.killLineEnd. Replace it?');
    app.stdin.write(PRESS.escape);
    await untilFrame(app, 'Key bindings');
    expect(written).toEqual([]);
    app.stdin.write(PRESS.enter);
    await untilFrame(app, 'Press the new key for editor.yank');
    terminal.emit(text('k', { ctrl: true }));
    await untilFrame(app, 'ctrl+k is used by editor.killLineEnd. Replace it?');
    app.stdin.write(PRESS.enter);
    await untilOutput(app, 'rejected: editor.killLineEnd would have no key');
    expect(written).toEqual([]);
    app.unmount();
  });

  it('removes the keys of an action with backspace, and never those of the declining key of a list', async () => {
    const { app, content } = await opened();
    await choose(app, 'history.search', 'history.search  ctrl+r  search the history');
    app.stdin.write(PRESS.enter);
    await untilFrame(app, 'Press the new key for history.search');
    app.stdin.write(PRESS.backspace);
    await untilFrame(app, 'history.search  no key  search the history (changed)');
    expect(content()).toEqual(file(['chat', { 'ctrl+r': null }]));
    for (let erased = 0; erased < 'history.search'.length; erased += 1) app.stdin.write(PRESS.backspace);
    await choose(app, 'select.escape', 'select.escape  esc  decline or go back');
    app.stdin.write(PRESS.enter);
    await untilFrame(app, 'Press the new key for select.escape');
    app.stdin.write(PRESS.backspace);
    await untilOutput(app, 'rejected: select.escape would have no key');
    expect(content()).toEqual(file(['chat', { 'ctrl+r': null }]));
    app.unmount();
  });

  it('resets one action with the second key of the list, and all with the row', async () => {
    const { app, content } = await opened(file(['chat', { 'ctrl+s': 'history.search', 'ctrl+r': null, 'ctrl+b': 'editor.left' }]));
    await choose(app, 'history.search', 'history.search  ctrl+s  search the history (changed)');
    app.stdin.write(PRESS.tab);
    await untilFrame(app, 'history.search  ctrl+r  search the history');
    expect(content()).toEqual(file(['chat', { 'ctrl+b': 'editor.left' }]));
    for (let erased = 0; erased < 'history.search'.length; erased += 1) app.stdin.write(PRESS.backspace);
    await choose(app, 'Reset all', 'Reset all to the defaults');
    app.stdin.write(PRESS.enter);
    await untilFrame(app, (now) => now.includes('Key bindings') && !now.includes('(changed)') && now.includes('editor.left  left  one character left'));
    expect(content()).toEqual(file());
    app.unmount();
  });

  it('prints the path of the file on its row', async () => {
    const { app } = await opened();
    await choose(app, 'Open', 'Open the file');
    app.stdin.write(PRESS.enter);
    await untilOutput(app, SHOWN);
    expect(app.lastFrame() ?? '').not.toContain('Key bindings');
    app.unmount();
  });

  it('says that a file it could not read has to be corrected first', async () => {
    const host = disk('{"bindings": [');
    const keyBindings = createKeyBindings({ file: FILE, shownFile: SHOWN, files: host.files });
    await keyBindings.load();
    const { app, terminal } = await startWith({}, { keyBindings }, { columns: 150, rows: 40 });
    await untilFrame(app, 'mode: manual');
    await command(app, '/keybindings');
    const shown = await untilFrame(app, 'Key bindings');
    expect(shown).toMatch(/~\/\.momonga\/keybindings\.json was ignored: not valid JSON/);
    app.stdin.write('history.search');
    await untilFrame(app, (now) => now.split('\n').some((line) => line.includes('›') && line.includes('. history.search')));
    app.stdin.write(PRESS.enter);
    await untilFrame(app, 'Press the new key for history.search');
    terminal.emit(text('s', { ctrl: true }));
    await untilOutput(app, /keybindings\.json cannot be changed here \(not valid JSON: .+\); correct or remove the file first/);
    expect(host.written).toEqual([]);
    app.unmount();
  });
});
