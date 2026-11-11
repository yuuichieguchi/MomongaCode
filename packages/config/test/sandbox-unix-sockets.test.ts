import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTINGS_SCHEMA, loadSettings, loadUserSettings } from '@momonga/config';
import { localSettingsPath, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

describe('sandboxUnixSockets setting', () => {
  it('is declared in the settings schema as an object with a list of paths', () => {
    const properties = SETTINGS_SCHEMA.properties as Record<string, unknown>;
    expect(properties['sandboxUnixSockets']).toEqual({ type: 'object', properties: { allow: { type: 'array', items: { type: 'string', minLength: 1 } } }, additionalProperties: false });
  });

  it('is empty by default', async () => {
    const tree = makeTree();
    const result = await loadUserSettings({ home: tree.home, signal: new AbortController().signal });
    expect(result.settings.sandboxUnixSockets).toEqual({ allow: [] });
  });

  it('is honoured from user settings', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { sandbox: 'seatbelt', sandboxUnixSockets: { allow: ['/var/run/agent', '/tmp/x.sock'] } });
    const result = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.sandboxUnixSockets).toEqual({ allow: ['/var/run/agent', '/tmp/x.sock'] });
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ['project', projectSettingsPath],
    ['local', localSettingsPath],
  ] as const)('is discarded from %s settings with a warning naming the file', async (_name, fileOf) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { sandbox: 'seatbelt', sandboxUnixSockets: { allow: ['/var/run/agent'] } });
    const file = writeJson(fileOf(tree), { sandboxUnixSockets: { allow: ['/var/run/docker.sock'] } });
    const result = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.sandboxUnixSockets).toEqual({ allow: ['/var/run/agent'] });
    expect(result.warnings).toEqual([`${file}: sandboxUnixSockets is only honored in user settings; discarded`]);
  });

  it('refuses an entry that is not an absolute path, naming the pointer', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { sandboxUnixSockets: { allow: ['/ok', 'agent.sock'] } });
    await expect(loadUserSettings({ home: tree.home, signal: new AbortController().signal })).rejects.toThrow(`${file}: invalid settings at /sandboxUnixSockets/allow/1: not an absolute path`);
  });

  it('drops an entry inside a directory momonga owns, with a warning', async () => {
    const tree = makeTree();
    const owned = path.join(tree.home, '.momonga', 'run');
    const file = writeJson(userSettingsPath(tree), { sandbox: 'seatbelt', sandboxUnixSockets: { allow: [owned, '/var/run/agent'] } });
    const result = await loadUserSettings({ home: tree.home, signal: new AbortController().signal });
    expect(result.settings.sandboxUnixSockets).toEqual({ allow: ['/var/run/agent'] });
    expect(result.warnings).toEqual([`${file}: sandboxUnixSockets.allow entry ${JSON.stringify(owned)} is inside a directory momonga owns; its sockets are always denied; discarded`]);
  });

  it('drops an entry that reaches a directory momonga owns through a link to the home', async () => {
    const tree = makeTree();
    const linkedHome = path.join(path.dirname(tree.home), 'home-link');
    fs.symlinkSync(tree.home, linkedHome, 'dir');
    fs.mkdirSync(path.join(tree.home, '.momonga', 'run'), { recursive: true, mode: 0o700 });
    const throughLink = path.join(linkedHome, '.momonga', 'run', 'agent.sock');
    const file = writeJson(userSettingsPath(tree), { sandbox: 'seatbelt', sandboxUnixSockets: { allow: [throughLink, '/var/run/agent'] } });
    const result = await loadUserSettings({ home: tree.home, signal: new AbortController().signal });
    expect(result.settings.sandboxUnixSockets).toEqual({ allow: ['/var/run/agent'] });
    expect(result.warnings).toEqual([`${file}: sandboxUnixSockets.allow entry ${JSON.stringify(throughLink)} is inside a directory momonga owns; its sockets are always denied; discarded`]);
  });

  it('drops an entry inside a directory momonga owns when the home itself is given through a link', async () => {
    const tree = makeTree();
    const linkedHome = path.join(path.dirname(tree.home), 'home-link');
    fs.symlinkSync(tree.home, linkedHome, 'dir');
    const real = path.join(tree.home, '.momonga', 'run', 'agent.sock');
    const file = writeJson(userSettingsPath(tree), { sandbox: 'seatbelt', sandboxUnixSockets: { allow: [real] } });
    const result = await loadUserSettings({ home: linkedHome, signal: new AbortController().signal });
    expect(result.settings.sandboxUnixSockets).toEqual({ allow: [] });
    expect(result.warnings).toEqual([`${path.join(linkedHome, '.momonga', 'settings.json')}: sandboxUnixSockets.allow entry ${JSON.stringify(real)} is inside a directory momonga owns; its sockets are always denied; discarded`]);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('is honoured under the bubblewrap sandbox as under seatbelt, with no warning, and an entry in a folder momonga owns is dropped there too', async () => {
    const tree = makeTree();
    const owned = path.join(tree.home, '.momonga', 'run');
    const file = writeJson(userSettingsPath(tree), { sandbox: 'bubblewrap', sandboxUnixSockets: { allow: ['/var/run/agent', owned] } });
    const result = await loadUserSettings({ home: tree.home, signal: new AbortController().signal });
    expect(result.settings.sandboxUnixSockets).toEqual({ allow: ['/var/run/agent'] });
    expect(result.warnings).toEqual([`${file}: sandboxUnixSockets.allow entry ${JSON.stringify(owned)} is inside a directory momonga owns; its sockets are always denied; discarded`]);
    expect(result.warnings.join('\n')).not.toContain('not supported by the Linux sandbox');
  });

  it('says nothing under the bubblewrap sandbox when the list is empty', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { sandbox: 'bubblewrap', sandboxUnixSockets: { allow: [] } });
    expect((await loadUserSettings({ home: tree.home, signal: new AbortController().signal })).warnings).toEqual([]);
  });
});
