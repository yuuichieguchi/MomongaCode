import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, SETTINGS_SCHEMA, TUI_SCREEN_MODES, defaultTuiSettings, editSettings, loadSettings, loadUserSettings, readSettingsSnapshot } from '@momonga/config';
import { distrusting, localSettingsPath, makeTree, mcpJsonPath, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';
import { testKernelLock } from '@momonga/testkit';
const UNABORTED = { lock: testKernelLock(), signal: new AbortController().signal };


const placeOf = (tree: Tree) => ({ home: tree.home, projectDir: tree.project });

const stored = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('editSettings', () => {
  it('sets one value in the user settings file, keeps every other key and writes the file with mode 0600', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeJson(file, { autoUpdates: false, context: { cachePrefix: true } });
    await editSettings(placeOf(tree), 'user', { kind: 'set', path: ['context', 'autoCompact'], value: false }, { ...UNABORTED, env: process.env });
    expect(stored(file)).toEqual({ autoUpdates: false, context: { cachePrefix: true, autoCompact: false } });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect((await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).settings.context.autoCompact).toBe(false);
  });

  it('creates the file and the objects on the way when there are none', async () => {
    const tree = makeTree();
    await editSettings(placeOf(tree), 'user', { kind: 'set', path: ['memory', 'reflection', 'maxTokens'], value: 900 }, { ...UNABORTED, env: process.env });
    expect(stored(userSettingsPath(tree))).toEqual({ memory: { reflection: { maxTokens: 900 } } });
  });

  it('removes a value and the objects it leaves empty', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeJson(file, { autoUpdates: false, telemetry: { otlp: { endpoint: 'http://127.0.0.1:4318' } } });
    await editSettings(placeOf(tree), 'user', { kind: 'unset', path: ['telemetry', 'otlp', 'endpoint'] }, { ...UNABORTED, env: process.env });
    expect(stored(file)).toEqual({ autoUpdates: false });
  });

  it('updates a list from the value the file holds', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeJson(file, { verification: { commands: ['npm test'] } });
    await editSettings(placeOf(tree), 'user', { kind: 'update', path: ['verification', 'commands'], update: (current) => [...(current as string[]), 'npm run typecheck'] }, { ...UNABORTED, env: process.env });
    expect(stored(file)).toEqual({ verification: { commands: ['npm test', 'npm run typecheck'] } });
  });

  it('leaves the file untouched when the value is the one it holds', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    fs.mkdirSync(`${tree.home}/.momonga`, { recursive: true });
    fs.writeFileSync(file, '{"autoUpdates":false}');
    await editSettings(placeOf(tree), 'user', { kind: 'set', path: ['autoUpdates'], value: false }, { ...UNABORTED, env: process.env });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"autoUpdates":false}');
  });

  it('refuses a value the schema refuses with the sentence of the loader and writes nothing', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeJson(file, { autoUpdates: false });
    const refused = editSettings(placeOf(tree), 'user', { kind: 'set', path: ['mcp', 'toolTotalTimeoutMs'], value: 0 }, { ...UNABORTED, env: process.env });
    await expect(refused).rejects.toBeInstanceOf(ConfigError);
    await expect(refused).rejects.toThrow(`${file}: invalid settings at /mcp/toolTotalTimeoutMs`);
    expect(stored(file)).toEqual({ autoUpdates: false });
  });

  it('refuses a value the loader refuses beyond the schema with the same sentence the loader gives', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    await expect(editSettings(placeOf(tree), 'user', { kind: 'set', path: ['tui', 'theme'], value: 'solarized' }, { ...UNABORTED, env: process.env })).rejects.toThrow(
      `${file}: invalid settings at /tui/theme: must be one of auto, dark, light, dark-colorblind, light-colorblind; got "solarized"`,
    );
    await expect(editSettings(placeOf(tree), 'user', { kind: 'set', path: ['tools', 'ripgrep'], value: 'rg' }, { ...UNABORTED, env: process.env })).rejects.toThrow(`${file}: invalid settings at /tools/ripgrep: must be "bundled", "system" or an absolute path; got "rg"`);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('writes into the project file and the local file of the project', async () => {
    const tree = makeTree();
    await editSettings(placeOf(tree), 'project', { kind: 'set', path: ['context', 'loopGuidance'], value: false }, { ...UNABORTED, env: process.env });
    await editSettings(placeOf(tree), 'local', { kind: 'set', path: ['context', 'cachePrefix'], value: true }, { ...UNABORTED, env: process.env });
    expect(stored(projectSettingsPath(tree))).toEqual({ context: { loopGuidance: false } });
    expect(stored(localSettingsPath(tree))).toEqual({ context: { cachePrefix: true } });
    const { settings } = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(settings.context).toMatchObject({ loopGuidance: false, cachePrefix: true });
  });

  it.each([
    [['sandbox'], 'none', 'sandbox is only honored in user settings; discarded'],
    [['tui', 'mouse'], false, 'tui.mouse is only honored in user settings; discarded'],
    [['permissions', 'defaultMode'], 'bypassPermissions', 'permissions.defaultMode bypassPermissions is only honored in user settings and on the command line; discarded'],
  ] as const)('refuses %j in the project file with the sentence the loader would warn with', async (path, value, sentence) => {
    const tree = makeTree();
    const file = projectSettingsPath(tree);
    await expect(editSettings(placeOf(tree), 'project', { kind: 'set', path, value }, { ...UNABORTED, env: process.env })).rejects.toThrow(`${file}: ${sentence}`);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('adds a permission rule once, checked by the parser of the loader', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    await editSettings(placeOf(tree), 'user', { kind: 'addRule', effect: 'allow', rule: 'Bash(npm test:*)' }, { ...UNABORTED, env: process.env });
    await editSettings(placeOf(tree), 'user', { kind: 'addRule', effect: 'allow', rule: 'Bash(npm test:*)' }, { ...UNABORTED, env: process.env });
    expect(stored(file)).toEqual({ permissions: { allow: ['Bash(npm test:*)'] } });
    await expect(editSettings(placeOf(tree), 'user', { kind: 'addRule', effect: 'deny', rule: 'Bash(' }, { ...UNABORTED, env: process.env })).rejects.toBeInstanceOf(ConfigError);
    expect(stored(file)).toEqual({ permissions: { allow: ['Bash(npm test:*)'] } });
  });

  it('adds a rule of the local layer through the rule writer of the approval prompt', async () => {
    const tree = makeTree();
    await editSettings(placeOf(tree), 'local', { kind: 'addRule', effect: 'ask', rule: 'Bash(git push:*)' }, { ...UNABORTED, env: process.env });
    expect(stored(localSettingsPath(tree))).toEqual({ permissions: { ask: ['Bash(git push:*)'] } });
  });

  it('has no project or local file for the home directory', async () => {
    const tree = makeTree();
    await expect(editSettings({ home: tree.home, projectDir: tree.home }, 'project', { kind: 'set', path: ['autoUpdates'], value: false }, { ...UNABORTED, env: process.env })).rejects.toThrow(`${tree.home} is the home directory; it has no project settings`);
  });
});

describe('editSettings on a file that does not load', () => {
  it('removes the value that keeps the user file from loading, and the file loads afterwards', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeJson(file, { autoUpdates: false, tui: { theme: 'bogus' } });
    await expect(loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).rejects.toBeInstanceOf(ConfigError);
    await editSettings(placeOf(tree), 'user', { kind: 'unset', path: ['tui', 'theme'] }, { ...UNABORTED, env: process.env });
    expect(stored(file)).toEqual({ autoUpdates: false });
    expect((await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).settings.autoUpdates).toBe(false);
  });

  it('replaces the value that keeps the file from loading by one that loads', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeJson(file, { tui: { theme: 'bogus' } });
    await editSettings(placeOf(tree), 'user', { kind: 'set', path: ['tui', 'theme'], value: 'dark' }, { ...UNABORTED, env: process.env });
    expect(stored(file)).toEqual({ tui: { theme: 'dark' } });
  });

  it('refuses an edit whose result still does not load, names the key of the result and keeps the bytes of the file', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeJson(file, { autoUpdates: false, tui: { theme: 'bogus' } });
    const before = fs.readFileSync(file, 'utf8');
    const refused = editSettings(placeOf(tree), 'user', { kind: 'set', path: ['autoUpdates'], value: true }, { ...UNABORTED, env: process.env });
    await expect(refused).rejects.toBeInstanceOf(ConfigError);
    await expect(refused).rejects.toThrow(`${file}: invalid settings at /tui/theme: must be one of`);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('removes a deny rule that cannot be read, which refuses the whole load until it is gone', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeJson(file, { permissions: { deny: ['Bash(', 'Bash(rm:*)'] } });
    await expect(loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).rejects.toBeInstanceOf(ConfigError);
    await editSettings(placeOf(tree), 'user', { kind: 'update', path: ['permissions', 'deny'], update: (current) => (current as string[]).filter((rule) => rule !== 'Bash(') }, { ...UNABORTED, env: process.env });
    expect(stored(file)).toEqual({ permissions: { deny: ['Bash(rm:*)'] } });
  });

  it('repairs a project file that does not load and also holds a value the loader discards with a warning', async () => {
    const tree = makeTree();
    const file = projectSettingsPath(tree);
    writeJson(file, { sandbox: 'none', context: { autoCompact: 'sometimes' } });
    await editSettings(placeOf(tree), 'project', { kind: 'unset', path: ['context', 'autoCompact'] }, { ...UNABORTED, env: process.env });
    expect(stored(file)).toEqual({ sandbox: 'none' });
  });
});

describe('readSettingsSnapshot', () => {
  it('gives each layer with its file and what the file holds, the layers a change may go to, and the defaults', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { autoUpdates: false });
    writeJson(projectSettingsPath(tree), { context: { loopGuidance: false } });
    const snapshot = await readSettingsSnapshot({ env: process.env, ...placeOf(tree), trusted: true, ...UNABORTED });
    expect(snapshot.layers).toEqual([
      { layer: 'user', file: userSettingsPath(tree), document: { autoUpdates: false } },
      { layer: 'project', file: projectSettingsPath(tree), document: { context: { loopGuidance: false } } },
      { layer: 'local', file: localSettingsPath(tree), document: {} },
    ]);
    expect(snapshot.targets).toEqual(['user', 'project', 'local']);
    expect(snapshot.defaults.autoUpdates).toBe(true);
    expect(snapshot.defaults.tui).toEqual({ theme: 'auto', notify: 'off', screenReader: false, reducedMotion: false, screen: 'fullscreen', mouse: true, copyOnSelect: true, attachFileMentions: true });
    expect(snapshot.mcpFile).toBe(mcpJsonPath(tree));
  });

  it('offers the user file and the local file for a project that is not trusted, every layer it shows, and does not read its project file', async () => {
    const tree = makeTree();
    writeJson(projectSettingsPath(tree), { context: { loopGuidance: false } });
    const snapshot = await readSettingsSnapshot({ env: process.env, ...placeOf(tree), trusted: false, ...UNABORTED });
    expect(snapshot.layers.map((view) => view.layer)).toEqual(['user', 'local']);
    expect(snapshot.targets).toEqual(['user', 'local']);
  });

  it('lets an edit of the local file win over the user file in a project that is not trusted', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { context: { loopGuidance: true } });
    writeJson(localSettingsPath(tree), { context: { loopGuidance: true } });
    await editSettings(placeOf(tree), 'local', { kind: 'set', path: ['context', 'loopGuidance'], value: false }, { ...UNABORTED, env: process.env });
    const { settings } = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: distrusting() });
    expect(settings.context.loopGuidance).toBe(false);
  });
});

describe('tui.screen, tui.mouse and tui.copyOnSelect', () => {
  it('are keys of the tui object with the two screen modes', () => {
    expect(TUI_SCREEN_MODES).toEqual(['fullscreen', 'scrollback']);
    const tui = SETTINGS_SCHEMA.properties.tui.properties;
    const defaults = defaultTuiSettings();
    expect(tui.screen).toEqual({ enum: ['fullscreen', 'scrollback'], default: defaults.screen });
    expect(tui.mouse).toEqual({ type: 'boolean', default: defaults.mouse });
    expect(tui.copyOnSelect).toEqual({ type: 'boolean', default: defaults.copyOnSelect });
  });

  it('default to fullscreen, true and true and take the value of the user file', async () => {
    const tree = makeTree();
    expect((await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).settings.tui).toMatchObject({ screen: 'fullscreen', mouse: true, copyOnSelect: true, attachFileMentions: true });
    writeJson(userSettingsPath(tree), { tui: { screen: 'scrollback', mouse: false, copyOnSelect: false } });
    expect((await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).settings.tui).toMatchObject({ screen: 'scrollback', mouse: false, copyOnSelect: false });
  });

  it('refuses a screen mode that is not one of the two', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { tui: { screen: 'default' } });
    await expect(loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).rejects.toThrow(`${userSettingsPath(tree)}: invalid settings at /tui/screen: must be one of fullscreen, scrollback; got "default"`);
  });

  it('cannot be set by a project or local file, which keeps its other tui keys', async () => {
    const tree = makeTree();
    writeJson(projectSettingsPath(tree), { tui: { screen: 'scrollback', mouse: false, copyOnSelect: false, theme: 'dark' } });
    const { settings, warnings } = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(settings.tui).toMatchObject({ screen: 'fullscreen', mouse: true, copyOnSelect: true, theme: 'dark' });
    expect(warnings).toEqual(['screen', 'mouse', 'copyOnSelect'].map((key) => `${projectSettingsPath(tree)}: tui.${key} is only honored in user settings; discarded`));
  });
});
