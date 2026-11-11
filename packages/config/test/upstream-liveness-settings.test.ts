import { describe, expect, it } from 'vitest';
import { loadSettings } from '@momonga/config';
import { localSettingsPath, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const FIVE_MINUTES_MS = 300_000;

const load = (models: Record<string, unknown> | undefined) => {
  const tree = makeTree();
  if (models !== undefined) writeJson(userSettingsPath(tree), { models });
  return { tree, loaded: loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) }) };
};

describe('the upstream liveness settings', () => {
  it('resolve models.headersTimeoutMs and models.idleTimeoutMs to five minutes when nothing declares them', async () => {
    const { settings } = await load(undefined).loaded;
    expect(settings.models).toMatchObject({ headersTimeoutMs: FIVE_MINUTES_MS, idleTimeoutMs: FIVE_MINUTES_MS });
  });

  it('keep declared values', async () => {
    const { settings } = await load({ headersTimeoutMs: 1234, idleTimeoutMs: 5678 }).loaded;
    expect(settings.models).toMatchObject({ headersTimeoutMs: 1234, idleTimeoutMs: 5678 });
  });

  it.for([
    { key: 'headersTimeoutMs', value: -1 },
    { key: 'idleTimeoutMs', value: -1 },
    { key: 'headersTimeoutMs', value: 1.5 },
    { key: 'idleTimeoutMs', value: '300000' },
  ])('refuse $key = $value, naming the key', async ({ key, value }) => {
    const { tree, loaded } = load({ [key]: value });
    await expect(loaded).rejects.toThrow(userSettingsPath(tree));
    await expect(loaded).rejects.toThrow(key);
  });

  it.for([
    { label: 'project', locate: projectSettingsPath, key: 'headersTimeoutMs' },
    { label: 'project', locate: projectSettingsPath, key: 'idleTimeoutMs' },
    { label: 'local', locate: localSettingsPath, key: 'headersTimeoutMs' },
    { label: 'local', locate: localSettingsPath, key: 'idleTimeoutMs' },
  ])('discard models.$key from $label settings with a warning naming the file', async ({ locate, key }) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { models: { [key]: 1234 } });
    const file = writeJson(locate(tree), { models: { [key]: 9 } });
    const result = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.models).toMatchObject({ [key]: 1234 });
    expect(result.warnings.some((w) => w.includes(`models.${key} is only honored in user settings`) && w.includes(file))).toBe(true);
  });
});
