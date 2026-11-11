import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, createUserSettingsCache, loadSettings, loadUserSettings, noKeptRecords } from '@momonga/config';
import { canonsOf, localSettingsDir, localSettingsPath, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson, writeText } from './helpers.ts';
import type { Tree } from './helpers.ts';

const NOT_ABORTED = new AbortController().signal;

const T0 = new Date('2026-01-01T00:00:00Z');
const T1 = new Date('2026-01-01T00:00:10Z');
const T2 = new Date('2026-01-01T00:00:20Z');

const writeAt = (file: string, value: unknown, at: Date): void => {
  writeJson(file, value);
  fs.utimesSync(file, at, at);
};

const writeTextAt = (file: string, text: string, at: Date): void => {
  writeText(file, text);
  fs.utimesSync(file, at, at);
};

describe('loadUserSettings', () => {
  it('returns the defaults when there is no user settings file', async () => {
    const tree = makeTree();
    const result = await loadUserSettings({ home: tree.home, signal: new AbortController().signal });
    expect(result.settings.autoUpdates).toBe(true);
    expect(canonsOf(result.settings)).toEqual([]);
    expect((result.settings.models as unknown as { start: string | undefined; fallback: readonly string[] }).start).toBeUndefined();
    expect((result.settings.models as unknown as { start: string | undefined; fallback: readonly string[] }).fallback).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.files).toEqual([]);
  });

  it('reads only the user layer and ignores project and local files', async () => {
    const tree = makeTree();
    const user = writeJson(userSettingsPath(tree), { autoUpdates: false, env: { TZ: 'user' } });
    writeJson(projectSettingsPath(tree), { env: { TZ: 'project' } });
    writeJson(localSettingsPath(tree), { env: { TZ: 'local' } });
    const result = await loadUserSettings({ home: tree.home, signal: new AbortController().signal });
    expect(result.settings.autoUpdates).toBe(false);
    expect(result.settings.env).toEqual({ TZ: 'user' });
    expect(result.files).toEqual([user]);
  });

  it('fails with a ConfigError naming the file for an invalid user file', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { permissions: { allow: 'Bash(ls)' } });
    const failure = loadUserSettings({ home: tree.home, signal: new AbortController().signal });
    await expect(failure).rejects.toBeInstanceOf(ConfigError);
    await expect(failure).rejects.toThrow(file);
  });

  it('fails with a ConfigError for malformed JSON', async () => {
    const tree = makeTree();
    writeText(userSettingsPath(tree), '{ "autoUpdates": ');
    await expect(loadUserSettings({ home: tree.home, signal: new AbortController().signal })).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('createUserSettingsCache', () => {
  const cacheFor = (tree: Tree) => {
    const warnings: string[] = [];
    const cache = createUserSettingsCache({ home: tree.home, onWarning: (message: string) => warnings.push(message), keptRecords: noKeptRecords });
    return { cache, warnings };
  };

  it('serves the current user settings synchronously', async () => {
    const tree = makeTree();
    writeAt(userSettingsPath(tree), { autoUpdates: false }, T0);
    const { cache } = cacheFor(tree);
    expect((await cache.loadOrKeep(NOT_ABORTED)).settings.autoUpdates).toBe(false);
  });

  it('serves the defaults when no file exists', async () => {
    const tree = makeTree();
    const { cache } = cacheFor(tree);
    expect((await cache.loadOrKeep(NOT_ABORTED)).settings.autoUpdates).toBe(true);
  });

  it('re-reads the file when its mtime changes', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { MODE: 'one' } }, T0);
    const { cache } = cacheFor(tree);
    expect((await cache.loadOrKeep(NOT_ABORTED)).settings.env).toEqual({ MODE: 'one' });
    writeAt(file, { env: { MODE: 'two' } }, T1);
    expect((await cache.loadOrKeep(NOT_ABORTED)).settings.env).toEqual({ MODE: 'two' });
  });

  it('sees a rewrite of the same size with the same mtime', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { MODE: 'one' } }, T0);
    const { cache } = cacheFor(tree);
    expect((await cache.loadOrKeep(NOT_ABORTED)).settings.env).toEqual({ MODE: 'one' });
    writeAt(file, { env: { MODE: 'two' } }, T0);
    expect((await cache.loadOrKeep(NOT_ABORTED)).settings.env).toEqual({ MODE: 'two' });
  });

  it('detects a same-mtime rewrite of a different size', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { MODE: 'one' } }, T0);
    const { cache } = cacheFor(tree);
    expect((await cache.loadOrKeep(NOT_ABORTED)).settings.env).toEqual({ MODE: 'one' });
    writeAt(file, { env: { MODE: 'longer-value' } }, T0);
    expect((await cache.loadOrKeep(NOT_ABORTED)).settings.env).toEqual({ MODE: 'longer-value' });
  });

  it('detects an atomic rename replacement with the same mtime and size', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { MODE: 'one' } }, T0);
    const { cache } = cacheFor(tree);
    expect((await cache.loadOrKeep(NOT_ABORTED)).settings.env).toEqual({ MODE: 'one' });
    const replacement = `${file}.next`;
    writeAt(replacement, { env: { MODE: 'two' } }, T0);
    const before = fs.statSync(file);
    expect(fs.statSync(replacement).size).toBe(before.size);
    fs.renameSync(replacement, file);
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(fs.statSync(file).ino).not.toBe(before.ino);
    expect((await cache.loadOrKeep(NOT_ABORTED)).settings.env).toEqual({ MODE: 'two' });
  });

  it('keeps the last good value and warns naming the file when a later parse fails', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { MODE: 'good' } }, T0);
    const { cache, warnings } = cacheFor(tree);
    expect((await cache.loadOrKeep(NOT_ABORTED)).settings.env).toEqual({ MODE: 'good' });
    writeTextAt(file, '{ "env": ', T1);
    expect((await cache.loadOrKeep(NOT_ABORTED)).settings.env).toEqual({ MODE: 'good' });
    expect(warnings.some((warning) => warning.includes(file))).toBe(true);
    writeAt(file, { env: { MODE: 'fixed' } }, T2);
    expect((await cache.loadOrKeep(NOT_ABORTED)).settings.env).toEqual({ MODE: 'fixed' });
  });

  it('keeps the last good value when a later file violates the schema', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { MODE: 'good' } }, T0);
    const { cache, warnings } = cacheFor(tree);
    expect((await cache.loadOrKeep(NOT_ABORTED)).settings.env).toEqual({ MODE: 'good' });
    writeAt(file, { models: { connections: [{ adapter: 'chat-completions', provider: 'remote', models: [{ id: 'x' }] }] } }, T1);
    expect((await cache.loadOrKeep(NOT_ABORTED)).settings.env).toEqual({ MODE: 'good' });
    expect(warnings).toHaveLength(1);
  });

  it('fails closed on first use when the initial load fails', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeTextAt(file, '{ "env": ', T0);
    const { cache } = cacheFor(tree);
    await expect(cache.loadOrKeep(NOT_ABORTED)).rejects.toThrow(file);
    await expect(cache.loadOrKeep(NOT_ABORTED)).rejects.toThrow(ConfigError);
  });
});

describe('project directory equal to home', () => {
  it('skips the project and local layers when projectDir is home', async () => {
    const tree = makeTree();
    const user = writeJson(userSettingsPath(tree), { permissions: { allow: ['Bash(git status)'] } });
    writeJson(path.join(localSettingsDir({ home: tree.home, project: tree.home }), 'settings.local.json'), {
      permissions: { allow: ['Bash(curl:*)'] },
    });
    const result = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.home, cli: {}, trust: { isTrusted: () => true } });
    expect(result.rules.map((rule) => [rule.text, rule.origin])).toEqual([['Bash(git status)', 'user']]);
    expect(result.files).toEqual([user]);
  });

  it('skips them when projectDir is a symlink resolving to home', async () => {
    const tree = makeTree();
    const user = writeJson(userSettingsPath(tree), { permissions: { allow: ['Bash(git status)'] } });
    const link = path.join(path.dirname(tree.home), 'home-link');
    fs.symlinkSync(tree.home, link);
    writeJson(path.join(localSettingsDir({ home: tree.home, project: tree.home }), 'settings.local.json'), {
      permissions: { allow: ['Bash(curl:*)'] },
    });
    const result = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: link, cli: {}, trust: { isTrusted: () => true } });
    expect(result.rules.map((rule) => [rule.text, rule.origin])).toEqual([['Bash(git status)', 'user']]);
    expect(result.files).toEqual([user]);
  });

  it('still loads the project layer for a different directory', async () => {
    const tree = makeTree();
    writeJson(projectSettingsPath(tree), { permissions: { allow: ['Read(./src/**)'] } });
    const result = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.rules.map((rule) => rule.origin)).toEqual(['project']);
  });
});

describe('defaultModeOrigin', () => {
  const load = (tree: Tree, cli: Record<string, unknown> = {}) =>
    loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli, trust: trusting(tree) });

  it('is undefined when no layer sets defaultMode', async () => {
    const result = await load(makeTree());
    expect(result.settings.permissions.defaultMode).toBeUndefined();
    expect(result.settings.permissions.defaultModeOrigin).toBeUndefined();
  });

  it('is user when only the user layer sets it', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { permissions: { defaultMode: 'plan' } });
    expect((await load(tree)).settings.permissions.defaultModeOrigin).toBe('user');
  });

  it('is project when the project layer overrides the user layer', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { permissions: { defaultMode: 'plan' } });
    writeJson(projectSettingsPath(tree), { permissions: { defaultMode: 'acceptEdits' } });
    const result = await load(tree);
    expect(result.settings.permissions.defaultMode).toBe('acceptEdits');
    expect(result.settings.permissions.defaultModeOrigin).toBe('project');
  });

  it('is local when the local layer sets it last', async () => {
    const tree = makeTree();
    writeJson(projectSettingsPath(tree), { permissions: { defaultMode: 'plan' } });
    writeJson(localSettingsPath(tree), { permissions: { defaultMode: 'acceptEdits' } });
    expect((await load(tree)).settings.permissions.defaultModeOrigin).toBe('local');
  });

  it('is cli when the command line sets it', async () => {
    const tree = makeTree();
    writeJson(localSettingsPath(tree), { permissions: { defaultMode: 'acceptEdits' } });
    const result = await load(tree, { permissions: { defaultMode: 'plan' } });
    expect(result.settings.permissions.defaultMode).toBe('plan');
    expect(result.settings.permissions.defaultModeOrigin).toBe('cli');
  });

  it('stays user when a project bypassPermissions is discarded', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { permissions: { defaultMode: 'acceptEdits' } });
    writeJson(projectSettingsPath(tree), { permissions: { defaultMode: 'bypassPermissions' } });
    const result = await load(tree);
    expect(result.settings.permissions.defaultMode).toBe('acceptEdits');
    expect(result.settings.permissions.defaultModeOrigin).toBe('user');
  });
});
