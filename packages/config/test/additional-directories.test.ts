import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadSettings, loadUserSettings } from '@momonga/config';
import { makeTree, trusting, userSettingsPath, writeJson } from './helpers.ts';

const failureOf = async (promise: Promise<unknown>): Promise<Error> => {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) throw new Error('expected the load to fail');
  return outcome;
};

describe('user additionalDirectories resolution', () => {
  it('a user additionalDirectories entry is resolved through canonicalDirectory', async () => {
    const tree = makeTree();
    const real = path.join(tree.home, 'real-extra');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(tree.home, 'linked-extra'), 'dir');
    writeJson(userSettingsPath(tree), { permissions: { additionalDirectories: ['~/linked-extra', './real-extra'] } });
    const result = await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal });
    expect(result.settings.permissions.additionalDirectories).toEqual([real, real]);
  });

  it('a missing entry is skipped with a warning naming the file and the entry, and the other entries load', async () => {
    const tree = makeTree();
    const present = path.join(tree.home, 'present-extra');
    fs.mkdirSync(present);
    const file = writeJson(userSettingsPath(tree), { autoUpdates: false, permissions: { additionalDirectories: ['~/missing-extra', '~/present-extra'] } });
    const result = await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal });
    expect(result.settings.permissions.additionalDirectories).toEqual([present]);
    expect(result.settings.autoUpdates).toBe(false);
    expect(result.warnings).toEqual([`${file}: additionalDirectories entry "~/missing-extra" does not exist; skipped`]);
  });

  it('a file entry beside a missing entry still fails the load', async () => {
    const tree = makeTree();
    fs.writeFileSync(path.join(tree.home, 'plain-file'), '');
    writeJson(userSettingsPath(tree), { permissions: { additionalDirectories: ['~/missing-extra', './plain-file'] } });
    const error = await failureOf(loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal }));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toMatch(/ is not a directory$/);
  });

  it('a file entry throws ConfigError with the "is not a directory" reason', async () => {
    const tree = makeTree();
    fs.writeFileSync(path.join(tree.home, 'plain-file'), '');
    const file = writeJson(userSettingsPath(tree), { permissions: { additionalDirectories: ['./plain-file'] } });
    const error = await failureOf(loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal }));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain(`${file}: additionalDirectories entry `);
    expect(error.message).toContain('./plain-file');
    expect(error.message).toMatch(/ is not a directory$/);
  });

  it('an entry below a symlink loop throws ConfigError with the "cannot be resolved" reason', async () => {
    const tree = makeTree();
    fs.symlinkSync(path.join(tree.home, 'loop-b'), path.join(tree.home, 'loop-a'));
    fs.symlinkSync(path.join(tree.home, 'loop-a'), path.join(tree.home, 'loop-b'));
    const file = writeJson(userSettingsPath(tree), { permissions: { additionalDirectories: ['~/loop-a'] } });
    const error = await failureOf(loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal }));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain(`${file}: additionalDirectories entry `);
    expect(error.message).toMatch(/ cannot be resolved: /);
  });

  it('a missing user entry is skipped by loadSettings with the same warning', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { permissions: { additionalDirectories: ['~/missing-extra'] } });
    const result = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.permissions.additionalDirectories).toEqual([]);
    expect(result.warnings).toEqual([`${file}: additionalDirectories entry "~/missing-extra" does not exist; skipped`]);
  });
});
