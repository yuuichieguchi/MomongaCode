import { describe, expect, it } from 'vitest';
import { SETTINGS_SCHEMA, loadSettings } from '@momonga/config';
import { localSettingsPath, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const FORGE = { id: 'work', descriptor: 'github', hosts: ['forge.example'], apiBaseUrl: 'https://api.forge.example', credential: { env: 'FORGE_TOKEN' } };

const loadUser = async (user: unknown) => {
  const tree = makeTree();
  const file = writeJson(userSettingsPath(tree), user);
  return { file, loading: loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) }) };
};

const settingsOf = async (files: { user?: unknown; project?: unknown; local?: unknown }) => {
  const tree = makeTree();
  if (files.user !== undefined) writeJson(userSettingsPath(tree), files.user);
  const projectFile = files.project === undefined ? undefined : writeJson(projectSettingsPath(tree), files.project);
  const localFile = files.local === undefined ? undefined : writeJson(localSettingsPath(tree), files.local);
  const result = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
  return { result, projectFile, localFile, settings: result.settings as unknown as Record<string, unknown> };
};

describe('forge instances in settings', () => {
  it('declares forges and operations in the settings schema', () => {
    expect(Object.keys(SETTINGS_SCHEMA.properties)).toEqual(expect.arrayContaining(['forges', 'operations']));
  });

  it('takes forges from user settings, with the credential as a reference', async () => {
    const { settings } = await settingsOf({ user: { forges: [FORGE] } });
    expect(settings['forges']).toEqual([FORGE]);
  });

  it('accepts a credential kept in the secret store by name', async () => {
    const forge = { ...FORGE, credential: { secret: 'forge-work' } };
    const { settings } = await settingsOf({ user: { forges: [forge] } });
    expect(settings['forges']).toEqual([forge]);
  });

  it('refuses a credential given by value, while the same forge with a reference loads', async () => {
    expect((await settingsOf({ user: { forges: [FORGE] } })).settings['forges']).toEqual([FORGE]);
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { forges: [{ ...FORGE, credential: 'not-a-reference' }] });
    await expect(loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) })).rejects.toThrow();
  });

  it.each(['project', 'local'] as const)('discards forges from %s settings with a warning, so a repository cannot point a credential at its own host', async (layer) => {
    const files = layer === 'project' ? { user: { forges: [FORGE] }, project: { forges: [{ ...FORGE, apiBaseUrl: 'https://collector.invalid' }] } } : { user: { forges: [FORGE] }, local: { forges: [{ ...FORGE, apiBaseUrl: 'https://collector.invalid' }] } };
    const { result, settings, projectFile, localFile } = await settingsOf(files);
    expect(settings['forges']).toEqual([FORGE]);
    const file = layer === 'project' ? projectFile : localFile;
    expect(result.warnings).toContain(`${file}: forges is only honored in user settings; discarded`);
  });

  it('leaves forges absent when no file declares them, and present when the user file does', async () => {
    expect((await settingsOf({})).settings['forges']).toBeUndefined();
    expect((await settingsOf({ user: { forges: [FORGE] } })).settings['forges']).toEqual([FORGE]);
  });

  it('refuses a forge with no credential reference and one with two', async () => {
    const { credential: _reference, ...bare } = FORGE;
    for (const forge of [bare, { ...FORGE, credential: { env: 'FORGE_TOKEN', secret: 'forge-work' } }, { ...FORGE, credential: {} }]) {
      const tree = makeTree();
      writeJson(userSettingsPath(tree), { forges: [forge] });
      await expect(loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) })).rejects.toThrow();
    }
  });
});

describe('the shape of a forge entry', () => {
  it('takes several hosts for one forge', async () => {
    const forge = { ...FORGE, hosts: ['forge.example', 'GIT.forge.example'] };
    const { settings } = await settingsOf({ user: { forges: [forge] } });
    expect(settings['forges']).toEqual([forge]);
  });

  it.each(['not a url', '/api/v3', 'ftp://forge.example/api'])('refuses apiBaseUrl %s when the settings load, naming the file and the key', async (apiBaseUrl) => {
    const { file, loading } = await loadUser({ forges: [{ ...FORGE, apiBaseUrl }] });
    await expect(loading).rejects.toThrow(`${file}: invalid settings at /forges/0/apiBaseUrl`);
  });

  it.each([
    ['a single host', { id: 'work', descriptor: 'github', host: 'forge.example', apiBaseUrl: 'https://api.forge.example', credential: { env: 'FORGE_TOKEN' } }],
    ['a flat credential name', { id: 'work', descriptor: 'github', hosts: ['forge.example'], apiBaseUrl: 'https://api.forge.example', credentialEnv: 'FORGE_TOKEN' }],
    ['no host', { ...FORGE, hosts: [] }],
  ])('refuses %s', async (_name, forge) => {
    const { loading } = await loadUser({ forges: [forge] });
    await expect(loading).rejects.toThrow();
  });
});

describe('operation settings (OD-6)', () => {
  it('takes the approval class of an operation and the protected refs from user settings', async () => {
    const operations = { approval: { PullRequestMerge: 'rule' }, protectedRefs: ['main', 'release/*'] };
    const { settings } = await settingsOf({ user: { operations } });
    expect(settings['operations']).toEqual(operations);
  });

  it.each(['project', 'local'] as const)('discards operations from %s settings, so only the user can relax a must-approve operation', async (layer) => {
    const relaxed = { operations: { approval: { PullRequestMerge: 'rule' } } };
    const { result, settings, projectFile, localFile } = await settingsOf(layer === 'project' ? { project: relaxed } : { local: relaxed });
    expect(settings['operations']).toBeUndefined();
    const file = layer === 'project' ? projectFile : localFile;
    expect(result.warnings).toContain(`${file}: operations is only honored in user settings; discarded`);
  });

  it('refuses an approval class other than rule or always, while always loads', async () => {
    expect((await settingsOf({ user: { operations: { approval: { PullRequestMerge: 'always' } } } })).settings['operations']).toEqual({ approval: { PullRequestMerge: 'always' } });
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { operations: { approval: { PullRequestMerge: 'never' } } });
    await expect(loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) })).rejects.toThrow();
  });
});
