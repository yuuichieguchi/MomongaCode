import fs from 'node:fs';
import path from 'node:path';
import { loadUserSettings, writeTuiSetting } from '@momonga/config';
import { OUTPUT_FORMATTERS } from '@momonga/protocol';
import { describe, expect, it, vi } from 'vitest';
import { MANDATE_ROW, OPEN_FILE_TITLE, ADD_ROW, APPLIES_NEXT_DAEMON_START, APPLIES_NEXT_SESSION, APPLIES_NOW, COMMAND_LINKS, OPEN_SETTINGS_FILE_ROW, SAVE_TO_TITLE, SETTINGS_TITLE, SETTING_ROWS, STRUCTURED_LINES, settingLeaves } from '../../src/tui/settings-screen.tsx';
import type { TuiSettingsPort } from '../../src/tui/screen/notify.ts';
import type { ExternalEditorPort } from '../../src/tui/external-editor.ts';
import { KEYS, TUI_TEST_TIMEOUT_MS, untilFrame, untilOutput } from '../ink-helpers.ts';
import { command, freshPlace, localFileOf, outputHolds, press, startAt, stored, typeInto, unwrapped, writeSettings } from './settings-harness.tsx';
import type { Place, Started } from './settings-harness.tsx';
import { testKernelLock } from '@momonga/testkit';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

const CLEAR = `${KEYS.ctrlA}${KEYS.ctrlK}`;
const SUBMIT = `${KEYS.ctrlX}${KEYS.enter}`;

const open = (started: Started): Promise<string> => command(started, '/config', SETTINGS_TITLE);

const openRow = async (started: Started, label: string, shown: string | RegExp): Promise<string> => {
  await press(started, label, `filter: ${label}`);
  return press(started, KEYS.enter, shown);
};

const realPort = async (place: Place): Promise<TuiSettingsPort> => ({
  initial: (await loadUserSettings({ env: process.env, home: place.home, signal: new AbortController().signal })).settings.tui,
  save: (name, value, signal) => writeTuiSetting(place.home, place.userFile, name, value, { lock: testKernelLock(), signal }),
});

describe('/config, the settings screen', () => {
  it('lists every setting of the schema that has a row, with its value and where the value comes from', async () => {
    const place = freshPlace();
    writeSettings(place.userFile, { autoUpdates: false });
    writeSettings(place.projectFile, { context: { loopGuidance: true } });
    const started = await startAt(place);
    await open(started);
    const frame = await untilFrame(started.app, 'type to filter · esc: go back');
    const rows = settingLeaves().flatMap((leaf) => (SETTING_ROWS[leaf.key] === undefined ? [] : [SETTING_ROWS[leaf.key]?.label ?? '']));
    expect(rows.length).toBeGreaterThan(40);
    for (const label of rows) expect(frame, label).toContain(label);
    expect(frame).toContain(`1. ${OPEN_SETTINGS_FILE_ROW}`);
    expect(frame).toContain('Ring the terminal bell when a run ends or needs you  off  default');
    expect(frame).toContain('Screen-reader display  off  default');
    expect(frame).toContain('Reduced motion  off  default');
    expect(frame).toContain('Screen mode at start  fullscreen  default');
    expect(frame).toContain('Mouse  on  default');
    expect(frame).toContain('Copy on select  on  default');
    expect(frame).toContain('Automatic updates  off  user');
    expect(frame).toContain('Loop guidance  on  project');
    expect(frame).toContain('Schema dialects  none  default');
    expect(frame).toContain('Sandbox  ');
    for (const [name, link] of Object.entries(COMMAND_LINKS)) expect(frame).toContain(`${link.label}  /${name}`);
    expect(frame).toContain('up/down to move · enter to choose · type to filter · esc: go back');
    started.app.unmount();
  });

  it('toggles a switch in place, writes it to the user file and says when the change applies', async () => {
    const place = freshPlace();
    const started = await startAt(place);
    await open(started);
    await openRow(started, 'Automatic compaction', `Automatic compaction  off  user  ${APPLIES_NOW}`);
    expect(stored(place.userFile)).toEqual({ context: { autoCompact: false } });
    await openRow(started, 'Automatic updates', `Automatic updates  off  user  ${APPLIES_NOW}`);
    expect(stored(place.userFile)).toEqual({ context: { autoCompact: false }, autoUpdates: false });
    started.app.unmount();
  });

  it('opens the selection for a value with fixed choices and asks before the sandbox is turned off', async () => {
    const place = freshPlace();
    const started = await startAt(place);
    await open(started);
    const choices = await openRow(started, 'Sandbox', '3. none');
    expect(choices).toContain('1. seatbelt');
    expect(choices).toContain('2. bubblewrap');
    await press(started, '3', '› 3. none');
    const question = await press(started, KEYS.enter, 'Run commands without a sandbox?');
    expect(question).toContain('› 1. No');
    expect(question).toContain('2. Yes');
    await press(started, KEYS.enter, SETTINGS_TITLE);
    expect(fs.existsSync(place.userFile)).toBe(false);
    await press(started, KEYS.enter, '3. none');
    await press(started, '3', '› 3. none');
    await press(started, KEYS.enter, 'Run commands without a sandbox?');
    await press(started, '2', '› 2. Yes');
    await press(started, KEYS.enter, `Sandbox  none  user  ${APPLIES_NOW}`);
    expect(stored(place.userFile)).toEqual({ sandbox: 'none' });
    started.app.unmount();
  });

  it('asks for a number with the range of the schema and refuses one outside it', async () => {
    const place = freshPlace();
    const started = await startAt(place);
    await open(started);
    const prompt = await openRow(started, 'Forget after (days)', 'a whole number from 1');
    expect(prompt).toContain('enter to confirm · esc: go back');
    await press(started, `${CLEAR}0`, '> 0');
    await press(started, KEYS.enter, 'expected a whole number from 1');
    expect(fs.existsSync(place.userFile)).toBe(false);
    await press(started, `${CLEAR}30`, '> 30');
    await press(started, KEYS.enter, `Forget after (days)  30  user  ${APPLIES_NOW}`);
    expect(stored(place.userFile)).toEqual({ memory: { forgetAfterDays: 30 } });
    started.app.unmount();
  });

  for (const size of [{ columns: 100, rows: 40 }, { columns: 40, rows: 24 }]) {
    describe(`at ${size.columns}x${size.rows} the applies text after a write is shown whole`, () => {
      it('for a setting a running daemon keeps until it restarts', async () => {
        const place = freshPlace();
        const started = await startAt(place, {}, undefined, { size });
        await open(started);
        await openRow(started, 'daemon', 'a whole number from 1');
        await press(started, `${CLEAR}90000`, '> 90000');
        await press(started, KEYS.enter, (frame) => frame.includes(APPLIES_NEXT_DAEMON_START));
        expect(stored(place.userFile)).toEqual({ daemon: { startupStallMs: 90000 } });
        started.app.unmount();
      });

      it('for a setting read at the start of the terminal session', async () => {
        const place = freshPlace();
        const started = await startAt(place, {}, undefined, { size });
        await open(started);
        await press(started, 'Mouse', 'filter: Mouse');
        await press(started, KEYS.enter, (frame) => frame.includes(APPLIES_NEXT_SESSION));
        expect(stored(place.userFile)).toEqual({ tui: { mouse: false } });
        started.app.unmount();
      });

      it('for a setting read per operation', async () => {
        const place = freshPlace();
        const started = await startAt(place, {}, undefined, { size });
        await open(started);
        await openRow(started, 'Forget after', 'a whole number from 1');
        await press(started, `${CLEAR}30`, '> 30');
        await press(started, KEYS.enter, (frame) => frame.includes(APPLIES_NOW));
        expect(stored(place.userFile)).toEqual({ memory: { forgetAfterDays: 30 } });
        started.app.unmount();
      });
    });
  }

  it('shows the range with both ends where the schema has both', async () => {
    const started = await startAt(freshPlace());
    await open(started);
    await openRow(started, 'Close grace (ms)', /a whole number from \d+ to \d+/);
    started.app.unmount();
  });

  it('refuses a value the loader refuses with the sentence of the loader and writes nothing', async () => {
    const place = freshPlace();
    const started = await startAt(place);
    await open(started);
    await openRow(started, 'ripgrep program', '> bundled');
    await press(started, `${CLEAR}rg`, '> rg');
    const refused = await press(started, KEYS.enter, 'invalid settings at /tools/ripgrep');
    expect(unwrapped(refused)).toContain(`${place.userFile}: invalid settings at /tools/ripgrep: must be "bundled", "system" or an absolute path; got "rg"`);
    expect(refused).toContain('ripgrep program  bundled  default');
    expect(fs.existsSync(place.userFile)).toBe(false);
    started.app.unmount();
  });

  it('edits a list of texts: add, move and remove', async () => {
    const place = freshPlace();
    const started = await startAt(place);
    await open(started);
    await openRow(started, 'Verification commands', 'Verification commands (user)');
    await press(started, KEYS.enter, 'enter to confirm');
    await typeInto(started, 'npm run lint', '1. npm run lint');
    await press(started, '2', '› 2. Add');
    await press(started, KEYS.enter, 'enter to confirm');
    await typeInto(started, 'npm run typecheck', '2. npm run typecheck');
    expect(stored(place.userFile)).toEqual({ verification: { commands: ['npm run lint', 'npm run typecheck'] } });
    await press(started, '2', '› 2. npm run typecheck');
    const actions = await press(started, KEYS.enter, '1. Move up');
    expect(actions).toContain('2. Move down');
    expect(actions).toContain('3. Remove');
    await press(started, KEYS.enter, '1. npm run typecheck');
    expect(stored(place.userFile)).toEqual({ verification: { commands: ['npm run typecheck', 'npm run lint'] } });
    await press(started, '1', '› 1. npm run typecheck');
    await press(started, KEYS.delete, 'Remove npm run typecheck?');
    expect(stored(place.userFile)).toEqual({ verification: { commands: ['npm run typecheck', 'npm run lint'] } });
    await press(started, '2', '› 2. Yes');
    await press(started, KEYS.enter, '1. npm run lint');
    expect(stored(place.userFile)).toEqual({ verification: { commands: ['npm run lint'] } });
    await press(started, KEYS.escape, `Verification commands  npm run lint  user  ${APPLIES_NOW}`);
    started.app.unmount();
  });

  it('edits a value with several choices as marks', async () => {
    const place = freshPlace();
    const started = await startAt(place);
    await open(started);
    const marks = await openRow(started, 'Output formatters', '[x] log');
    expect(marks).toContain('Output formatters (user)');
    await press(started, KEYS.enter, '[ ] log');
    expect(stored(place.userFile)).toEqual({ context: { outputFormatters: OUTPUT_FORMATTERS.filter((name) => name !== 'log') } });
    started.app.unmount();
  });

  it('edits the environment variables as NAME=value entries', async () => {
    const place = freshPlace();
    const started = await startAt(place);
    await open(started);
    await openRow(started, 'Environment variables', 'Environment variables (user)');
    await press(started, KEYS.enter, 'enter to confirm');
    await press(started, 'FOO', '> FOO');
    await press(started, KEYS.enter, 'expected NAME=value');
    await typeInto(started, '=bar baz', '1. FOO=bar baz');
    expect(stored(place.userFile)).toEqual({ env: { FOO: 'bar baz' } });
    started.app.unmount();
  });

  it('adds a price through the form of its fields', async () => {
    const place = freshPlace();
    const started = await startAt(place);
    await open(started);
    await openRow(started, 'Prices', 'Prices (user)');
    await press(started, KEYS.enter, 'Prices: Provider');
    await typeInto(started, 'acme', 'Prices: Model');
    await typeInto(started, 'big-1', 'Prices: In force from (YYYY-MM-DD)');
    await typeInto(started, '2026-11-01', 'Prices: Input, USD per million tokens');
    await typeInto(started, '1.5', 'Prices: Output, USD per million tokens');
    await typeInto(started, '6', 'Prices: Cached input, USD per million tokens (empty: none)');
    await press(started, KEYS.enter, 'Prices: Cache write, USD per million tokens (empty: none)');
    await press(started, KEYS.enter, '1. acme/big-1  from 2026-11-01  input 1.5  output 6');
    expect(stored(place.userFile)).toEqual({ pricing: [{ provider: 'acme', model: 'big-1', effectiveFrom: '2026-11-01', inputPerMTok: 1.5, outputPerMTok: 6, currency: 'USD' }] });
    started.app.unmount();
  });

  it('adds a forge with its hosts and its credential reference in the shape the loader takes', async () => {
    const place = freshPlace();
    const started = await startAt(place);
    await open(started);
    const label = 'Forges for pull request operations';
    await openRow(started, label, `${label} (user)`);
    await press(started, KEYS.enter, `${label}: Name`);
    await typeInto(started, 'work', `${label}: Forge kind`);
    await typeInto(started, 'github', `${label}: Hosts of the git remotes`);
    await typeInto(started, 'github.com, ssh.github.com', `${label}: API base URL`);
    await typeInto(started, 'https://api.github.com', `${label}: Token: environment variable name`);
    await typeInto(started, 'GITHUB_TOKEN', `${label}: Token: name in the secret store`);
    await press(started, KEYS.enter, '1. work  github  github.com, ssh.github.com  https://api.github.com');
    expect(stored(place.userFile)).toEqual({ forges: [{ id: 'work', descriptor: 'github', hosts: ['github.com', 'ssh.github.com'], apiBaseUrl: 'https://api.github.com', credential: { env: 'GITHUB_TOKEN' } }] });
    started.app.unmount();
  });

  it('offers Save to: user, project, local for a value that comes from the project file, and writes the layer chosen', async () => {
    const place = freshPlace();
    writeSettings(place.projectFile, { context: { loopGuidance: true } });
    const started = await startAt(place);
    await open(started);
    const target = await openRow(started, 'Loop guidance', SAVE_TO_TITLE);
    expect(target).toContain('1. user');
    expect(target).toContain('› 2. project');
    expect(target).toContain('3. local');
    await press(started, KEYS.enter, `Loop guidance  off  project  ${APPLIES_NOW}`);
    expect(stored(place.projectFile)).toEqual({ context: { loopGuidance: false } });
    expect(fs.existsSync(place.userFile)).toBe(false);
    await press(started, KEYS.enter, SAVE_TO_TITLE);
    await press(started, '3', '› 3. local');
    await press(started, KEYS.enter, 'Loop guidance  on  local');
    expect(stored(localFileOf(place))).toEqual({ context: { loopGuidance: true } });
    started.app.unmount();
  });

  it('writes a value of the default or of the user file to the user file without asking', async () => {
    const place = freshPlace();
    writeSettings(place.userFile, { context: { cachePrefix: true } });
    const started = await startAt(place);
    await open(started);
    await openRow(started, 'Cache prefix', `Cache prefix  off  user  ${APPLIES_NOW}`);
    expect(stored(place.userFile)).toEqual({ context: { cachePrefix: false } });
    started.app.unmount();
  });

  it('writes an edit to a layer that a higher layer shadows, says which layer and file shadow it, and shows the value in effect as unchanged', async () => {
    const place = freshPlace();
    writeSettings(localFileOf(place), { context: { cachePrefix: true } });
    const started = await startAt(place);
    await open(started);
    await openRow(started, 'Cache prefix', SAVE_TO_TITLE);
    await press(started, '1', '› 1. user');
    const frame = await press(started, KEYS.enter, `Saved to user.`);
    expect(stored(place.userFile)).toEqual({ context: { cachePrefix: false } });
    expect(unwrapped(frame).replaceAll(' ', '')).toContain(`local sets it in ${localFileOf(place)}, so the value in effect is still on.`.replaceAll(' ', ''));
    expect(unwrapped(frame)).toContain('Cache prefix on local');
    expect(unwrapped(frame)).not.toContain(APPLIES_NOW);
    started.app.unmount();
  });

  it('opens a structured value as JSON, shows a JSON error, and writes nothing the loader refuses', async () => {
    const place = freshPlace();
    const started = await startAt(place);
    await open(started);
    const editor = await openRow(started, 'Schema dialects', STRUCTURED_LINES[0]);
    expect(editor).toContain('> {}');
    await press(started, `${CLEAR}{"mine":`, '> {"mine":');
    await press(started, SUBMIT, /Unexpected end of JSON input|JSON/);
    await press(started, '7}', '> {"mine":7}');
    const refused = await press(started, SUBMIT, '/models/dialects/mine');
    expect(unwrapped(refused)).toContain('invalid settings at /models/dialects/mine: must be object');
    expect(refused).toContain('> {"mine":7}');
    expect(fs.existsSync(place.userFile)).toBe(false);
    started.app.unmount();
  });

  it('shows a value of several lines line by line in the structured editor', async () => {
    const place = freshPlace();
    const started = await startAt(place);
    await open(started);
    await openRow(started, 'Schema dialects', '> {}');
    await press(started, `${CLEAR}{${KEYS.ctrlJ}}`, /> \{\n {2}\}/);
    started.app.unmount();
  });

  it('adds a line at Enter in the structured editor, takes a paste at the caret, and hands the value to the loader at ctrl+x enter', async () => {
    const place = freshPlace();
    const started = await startAt(place);
    await open(started);
    await openRow(started, 'Schema dialects', '> {}');
    await press(started, `${CLEAR}{}${KEYS.left}`, '> {}');
    await press(started, KEYS.enter, /> \{\n {2}\}/);
    const pasted = await press(started, `${KEYS.pasteStart}"mine": {"type": "object"}${KEYS.pasteEnd}`, '"mine": {"type": "object"}}');
    expect(pasted).not.toContain('invalid settings');
    const refused = await press(started, SUBMIT, 'invalid settings at /models/dialects/mine');
    expect(refused).toContain('"mine": {"type": "object"}}');
    expect(fs.existsSync(place.userFile)).toBe(false);
    started.app.unmount();
  });

  it('opens the structured value in $EDITOR at ctrl+g and takes the edited text back into the editor', async () => {
    const place = freshPlace();
    const edited: string[] = [];
    const externalEditor: ExternalEditorPort = {
      edit: async (draft, kind) => {
        edited.push(`${kind}:${draft}`);
        return { kind: 'edited', text: '{"fromEditor": {}}' };
      },
      open: () => Promise.reject(new Error('no file is opened in this test')),
    };
    const started = await startAt(place, {}, undefined, { externalEditor });
    await open(started);
    await openRow(started, 'Schema dialects', '> {}');
    await press(started, KEYS.ctrlG, '> {"fromEditor": {}}');
    expect(edited).toEqual(['json:{}']);
    started.app.unmount();
  });

  it('pastes into a one-line prompt at the caret', async () => {
    const place = freshPlace();
    const started = await startAt(place);
    await open(started);
    await openRow(started, 'Forget after (days)', 'a whole number from 1');
    await press(started, `${CLEAR}10${KEYS.left}`, '> 10');
    await press(started, `${KEYS.pasteStart}2${KEYS.pasteEnd}`, '> 120');
    await press(started, KEYS.enter, 'Forget after (days)  120  user');
    expect(stored(place.userFile)).toEqual({ memory: { forgetAfterDays: 120 } });
    started.app.unmount();
  });

  it('lists the check commands by folder and edits the map as JSON in the structured editor, written to the user file', async () => {
    const place = freshPlace();
    writeSettings(place.userFile, { projectChecks: { '/work/a': { commands: ['npm test'] }, '/work/b': { declined: true } } });
    const externalEditor: ExternalEditorPort = { edit: async () => ({ kind: 'edited', text: '{"/work/a": {"commands": ["npm run check"]}}' }), open: () => Promise.reject(new Error('no file is opened in this test')) };
    const started = await startAt(place, {}, undefined, { externalEditor });
    const listed = await open(started);
    expect(listed).toContain('Check commands by folder  /work/a, /work/b  user');
    const editor = await openRow(started, 'Check commands by folder', STRUCTURED_LINES[0]);
    expect(editor).toContain('"/work/a"');
    await press(started, KEYS.ctrlG, 'npm run check');
    await press(started, SUBMIT, 'Check commands by folder  /work/a  user');
    expect(stored(place.userFile)).toEqual({ projectChecks: { '/work/a': { commands: ['npm run check'] } } });
    started.app.unmount();
  });

  it('lists the approvals by folder, withdraws one after asking, and has no row that adds one', async () => {
    const place = freshPlace();
    const digest = 'a'.repeat(64);
    writeSettings(place.userFile, { projectApprovals: { '/work/a': { hooks: [digest], mandate: digest }, '/work/b': { mandate: digest } } });
    const started = await startAt(place);
    await open(started);
    const list = await openRow(started, 'Approvals by folder', '/work/a  hooks approved: 1 · mandate approved');
    expect(list).toContain('/work/b  mandate approved');
    expect(list).not.toContain(`${ADD_ROW}\n`);
    expect(unwrapped(list)).not.toMatch(/\d\. Add /);
    await press(started, KEYS.enter, 'Remove');
    await press(started, KEYS.enter, 'Withdraw the approvals of /work/a?');
    await press(started, `${KEYS.down}${KEYS.enter}`, (frame) => frame.includes('/work/b  mandate approved') && !frame.includes('/work/a  hooks'));
    expect(stored(place.userFile)).toEqual({ projectApprovals: { '/work/b': { mandate: digest } } });
    started.app.unmount();
  });

  it('changes a display setting through the screen, stored in the user file and in force at once', async () => {
    const place = freshPlace();
    const started = await startAt(place, {}, await realPort(place));
    await open(started);
    await openRow(started, 'Ring the terminal bell', '2. bell');
    await press(started, '2', '› 2. bell');
    await press(started, KEYS.enter, `Ring the terminal bell when a run ends or needs you  bell  user  ${APPLIES_NOW}`);
    expect(stored(place.userFile)).toEqual({ tui: { notify: 'bell' } });
    await press(started, KEYS.escape, (frame) => !frame.includes(SETTINGS_TITLE));
    await command(started, '/config notify', '> /config notify');
    await untilOutput(started.app, 'notify: bell');
    started.app.unmount();
  });

  it('stores the three screen settings that are read at start', async () => {
    const place = freshPlace();
    const started = await startAt(place);
    await open(started);
    await openRow(started, 'Mouse', `Mouse  off  user  ${APPLIES_NEXT_SESSION}`);
    await openRow(started, 'Copy on select', `Copy on select  off  user  ${APPLIES_NEXT_SESSION}`);
    await openRow(started, 'Screen mode at start', '2. scrollback');
    await press(started, '2', '› 2. scrollback');
    await press(started, KEYS.enter, `Screen mode at start  scrollback  user  ${APPLIES_NEXT_SESSION}`);
    expect(stored(place.userFile)).toEqual({ tui: { mouse: false, copyOnSelect: false, screen: 'scrollback' } });
    expect((await loadUserSettings({ env: process.env, home: place.home, signal: new AbortController().signal })).settings.tui).toMatchObject({ mouse: false, copyOnSelect: false, screen: 'scrollback' });
    started.app.unmount();
  });

  it('opens the settings file chosen among every file in $EDITOR from the row Open the settings file', async () => {
    const place = freshPlace();
    const openedFiles: string[] = [];
    const started = await startAt(place, {}, undefined, { externalEditor: { edit: () => Promise.reject(new Error('not edited')), open: async (file) => { openedFiles.push(file); return { kind: 'opened' }; } } });
    await open(started);
    const files = await press(started, KEYS.enter, OPEN_FILE_TITLE);
    expect(files).toContain('1. user');
    expect(files).toContain('2. project');
    expect(files).toContain('3. local');
    expect(files).toContain('4. .mcp.json');
    expect(unwrapped(files)).toContain(`local: ${localFileOf(place)}`);
    await press(started, KEYS.enter, SETTINGS_TITLE);
    expect(openedFiles).toEqual([place.userFile]);
    started.app.unmount();
  });

  it('says how to set $EDITOR when no editor is set, naming the file', async () => {
    const place = freshPlace();
    const started = await startAt(place, {}, undefined, { externalEditor: { edit: () => Promise.reject(new Error('not edited')), open: async () => ({ kind: 'unset' }) } });
    await open(started);
    await press(started, KEYS.enter, OPEN_FILE_TITLE);
    await press(started, KEYS.enter, `Set $VISUAL or $EDITOR to open ${place.userFile}`);
    started.app.unmount();
  });

  it('edits the mandate file of a trusted folder through the one writer, shows the loader refusal and writes nothing refused', async () => {
    const place = freshPlace();
    const mandateFile = path.join(place.project, '.momonga', 'mandate.json');
    const started = await startAt(place);
    await open(started);
    const editor = await openRow(started, MANDATE_ROW, STRUCTURED_LINES[0]);
    expect(editor).toContain('> {}');
    await press(started, `${CLEAR}{"allow":["Bash"]}`, '> {"allow":["Bash"]}');
    const refused = await press(started, SUBMIT, 'can only be declared in the user settings');
    expect(unwrapped(refused)).toContain(`${mandateFile}: allow can only be declared in the user settings`);
    expect(fs.existsSync(mandateFile)).toBe(false);
    await press(started, `${CLEAR}{"steps":5}`, '> {"steps":5}');
    await press(started, SUBMIT, `${MANDATE_ROW}  steps 5`);
    expect(stored(mandateFile)).toEqual({ steps: 5 });
    started.app.unmount();
  });

  it('has no folder mandate row in a folder that is not trusted', async () => {
    const started = await startAt(freshPlace(), { trust: { path: '/work', decision: 'untrusted' } });
    const frame = await open(started);
    expect(frame).not.toContain(MANDATE_ROW);
    await press(started, 'mandate', 'filter: mandate');
    expect(started.app.lastFrame() ?? '').not.toContain(MANDATE_ROW);
    started.app.unmount();
  });

  it('opens the screen of another command from its row and comes back', async () => {
    const started = await startAt(freshPlace());
    await open(started);
    await openRow(started, 'Start mode, rules', 'Always protected');
    await press(started, KEYS.escape, SETTINGS_TITLE);
    started.app.unmount();
  });
});
