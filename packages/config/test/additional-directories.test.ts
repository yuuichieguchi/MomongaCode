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
    const result = await loadUserSettings({ home: tree.home });
    expect(result.settings.permissions.additionalDirectories).toEqual([real, real]);
  });

  it('a missing entry throws ConfigError with the "does not exist" reason', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { permissions: { additionalDirectories: ['~/missing-extra'] } });
    const error = await failureOf(loadUserSettings({ home: tree.home }));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain(`${file}: additionalDirectories entry `);
    expect(error.message).toContain('~/missing-extra');
    expect(error.message).toMatch(/ does not exist$/);
  });

  it('a file entry throws ConfigError with the "is not a directory" reason', async () => {
    const tree = makeTree();
    fs.writeFileSync(path.join(tree.home, 'plain-file'), '');
    const file = writeJson(userSettingsPath(tree), { permissions: { additionalDirectories: ['./plain-file'] } });
    const error = await failureOf(loadUserSettings({ home: tree.home }));
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
    const error = await failureOf(loadUserSettings({ home: tree.home }));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain(`${file}: additionalDirectories entry `);
    expect(error.message).toMatch(/ cannot be resolved: /);
  });

  it('a missing user entry also fails loadSettings with ConfigError', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { permissions: { additionalDirectories: ['~/missing-extra'] } });
    const error = await failureOf(loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) }));
    expect(error.message).toMatch(/additionalDirectories entry .* does not exist$/);
  });
});
