import { describe, expect, it } from 'vitest';
import { loadSettings } from '@momonga/config';
import { localSettingsPath, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

describe('credentials.plaintextTokenFiles (N81)', () => {
  it('is false when no settings file declares it', async () => {
    const tree = makeTree();
    const result = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.credentials.plaintextTokenFiles).toBe(false);
  });

  it('is true when the user settings set it', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { credentials: { plaintextTokenFiles: true } });
    const result = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.credentials.plaintextTokenFiles).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('is discarded from project and local settings with a warning naming the file', async () => {
    const tree = makeTree();
    const projectFile = writeJson(projectSettingsPath(tree), { credentials: { plaintextTokenFiles: true } });
    const localFile = writeJson(localSettingsPath(tree), { credentials: { plaintextTokenFiles: true } });
    const result = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.credentials.plaintextTokenFiles).toBe(false);
    for (const file of [projectFile, localFile]) {
      expect(result.warnings.some((warning) => warning.includes('credentials.plaintextTokenFiles') && warning.includes('only honored in user settings') && warning.includes(file))).toBe(true);
    }
  });

  it('rejects a value that is not a boolean', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { credentials: { plaintextTokenFiles: 'yes' } });
    await expect(loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) })).rejects.toThrow(/plaintextTokenFiles/);
  });
});
