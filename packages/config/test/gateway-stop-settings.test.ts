import { describe, expect, it } from 'vitest';
import { SETTINGS_SCHEMA, loadSettings, loadUserSettings } from '@momonga/config';
import { localSettingsPath, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const userGateway = async (gateway: Record<string, unknown> | undefined) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), gateway === undefined ? {} : { gateway });
  return (await loadUserSettings({ home: tree.home })).settings.gateway;
};

describe('gateway.closeGraceMs and gateway.managedServerStopGraceMs', () => {
  it('default to 10000 and 3000', async () => {
    expect(await userGateway(undefined)).toEqual({ closeGraceMs: 10_000, managedServerStopGraceMs: 3000 });
  });

  it('are described by the settings schema under one gateway object', () => {
    const gateway = SETTINGS_SCHEMA.properties['gateway'] as { properties: Record<string, unknown> };
    expect(Object.keys(gateway.properties).sort()).toEqual(['closeGraceMs', 'managedServerStopGraceMs']);
  });

  it.each([
    [{ closeGraceMs: 0, managedServerStopGraceMs: 0 }],
    [{ closeGraceMs: 300_000, managedServerStopGraceMs: 60_000 }],
    [{ closeGraceMs: 1234, managedServerStopGraceMs: 567 }],
  ])('accepts %o from user settings', async (values) => {
    expect(await userGateway(values)).toEqual(values);
  });

  it('keeps the default of the key that is not set', async () => {
    expect(await userGateway({ closeGraceMs: 0 })).toEqual({ closeGraceMs: 0, managedServerStopGraceMs: 3000 });
  });

  it.each([
    ['closeGraceMs', 300000, -1],
    ['closeGraceMs', 300000, 300_001],
    ['closeGraceMs', 300000, 1.5],
    ['closeGraceMs', 300000, '10000'],
    ['closeGraceMs', 300000, true],
    ['managedServerStopGraceMs', 60000, -1],
    ['managedServerStopGraceMs', 60000, 60_001],
    ['managedServerStopGraceMs', 60000, 2.5],
    ['managedServerStopGraceMs', 60000, null],
  ])('refuses gateway.%s up to %d given %o with the English message', async (key, max, value) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { gateway: { [key]: value } });
    await expect(loadUserSettings({ home: tree.home })).rejects.toThrow(
      `${userSettingsPath(tree)}: gateway.${key} must be an integer from 0 to ${max} milliseconds; got ${JSON.stringify(value)}`,
    );
  });

  it.each([
    ['project', projectSettingsPath],
    ['local', localSettingsPath],
  ] as const)('discards gateway from %s settings with a warning and keeps the user values', async (_label, locate) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { gateway: { closeGraceMs: 4000, managedServerStopGraceMs: 2000 } });
    const file = writeJson(locate(tree), { gateway: { closeGraceMs: 0, managedServerStopGraceMs: 0 } });
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.gateway).toEqual({ closeGraceMs: 4000, managedServerStopGraceMs: 2000 });
    expect(result.warnings).toContain(`${file}: gateway is only honored in user settings; discarded`);
  });
});
