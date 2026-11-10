import { describe, expect, it } from 'vitest';
import { createUserSettingsCache, derivedInputsOf, loadSettings, loadUserModels, loadUserSettings, noKeptRecords, settingsInputsDigest } from '@momonga/config';
import { createFakeManagedServer } from '@momonga/testkit';
import { connectionOf, makeDir, makeTree, modelOf, trusting, userSettingsPath, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';

const declaredHome = async (): Promise<{ tree: Tree; command: string }> => {
  const fake = await createFakeManagedServer({ dir: makeDir() });
  const tree = makeTree();
  writeJson(userSettingsPath(tree), {
    models: {
      servers: { loom: { command: fake.binaryPath, args: ['run', '--socket', '{socket}'], readyPath: '/ready' } },
      connections: [connectionOf('workbench', { adapter: 'managed', server: 'loom', model: 'fake-1' })],
    },
  });
  return { tree, command: fake.binaryPath };
};

const expectWorkbench = (target: unknown, command: string): void => {
  expect(target).toMatchObject({ adapter: 'managed', server: 'loom', binary: command, model: 'fake-1' });
};

describe('one registry for every reader of the user settings, built from the one file, with no port (design-managed-servers 19.6, 19.12; R-S19-9, R-S19-24)', () => {
  it('loadUserModels resolves a connection that names a declared server', async () => {
    const { tree, command } = await declaredHome();
    expectWorkbench(modelOf({ models: loadUserModels({ home: tree.home }).resolved }, 'workbench'), command);
  });

  it('loadUserSettings without a managedServers port resolves it', async () => {
    const { tree, command } = await declaredHome();
    expectWorkbench(modelOf((await loadUserSettings({ home: tree.home })).settings, 'workbench'), command);
  });

  it("the supervisor's createUserSettingsCache resolves it and gives no error snapshot", async () => {
    const { tree, command } = await declaredHome();
    const cache = createUserSettingsCache({ home: tree.home, onWarning: () => undefined, keptRecords: noKeptRecords });
    const snapshot = cache.snapshot();
    expect('error' in snapshot ? snapshot.error.message : undefined).toBeUndefined();
    expectWorkbench(modelOf(cache.get(), 'workbench'), command);
  });

  it('the layered loader of a session resolves it from the user layer', async () => {
    const { tree, command } = await declaredHome();
    expectWorkbench(modelOf((await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) })).settings, 'workbench'), command);
  });

  it("the gateway's pinned inputs cover the declared server it resolved", async () => {
    const { tree } = await declaredHome();
    const settings = (await loadUserSettings({ home: tree.home })).settings;
    const servers = settings.models.servers ?? {};
    const builtInOnly = Object.fromEntries(Object.entries(servers).filter(([id]) => id !== 'loom'));
    expect(Object.keys(servers).sort()).toEqual(['fm', 'loom']);
    const withoutDeclared = { ...settings, models: { ...settings.models, servers: builtInOnly } };
    expect(settingsInputsDigest(derivedInputsOf('D1')(settings))).not.toBe(settingsInputsDigest(derivedInputsOf('D1')(withoutDeclared)));
  });
});
