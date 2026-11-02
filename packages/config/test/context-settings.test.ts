import { describe, expect, it } from 'vitest';
import { loadSettings, loadUserSettings } from '@momonga/config';
import { distrusting, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const DEFAULT_COMMANDS = ['npm test', 'pnpm test', 'yarn test', 'cargo test', 'pytest', 'go test ./...', 'swift test', 'make test'];
const DEFAULT_MANIFESTS = ['package.json', 'pnpm-lock.yaml', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'Package.swift', 'Makefile'];

const resolvedWith = async (settings: Record<string, unknown>) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), settings);
  return (await loadUserSettings({ home: tree.home })).settings;
};

describe('context settings defaults', () => {
  it('turns reflection off, sets no fixed token cap, and forgets after 90 days', async () => {
    expect((await resolvedWith({})).memory).toEqual({ reflection: { enabled: false }, forgetAfterDays: 90 });
  });

  it('lists the documented verification commands and manifests', async () => {
    expect((await resolvedWith({})).verification).toEqual({ commands: DEFAULT_COMMANDS, manifests: DEFAULT_MANIFESTS });
  });

  it('keeps the adaptive budget off', async () => {
    expect((await resolvedWith({})).context).toEqual({ adaptiveBudget: false });
  });
});

describe('context settings values', () => {
  it('resolves every key the user sets', async () => {
    const settings = await resolvedWith({
      memory: { reflection: { enabled: true, maxTokens: 512 }, forgetAfterDays: 30 },
      verification: { commands: ['just check'], manifests: ['justfile'] },
      context: { adaptiveBudget: true },
    });
    expect(settings.memory).toEqual({ reflection: { enabled: true, maxTokens: 512 }, forgetAfterDays: 30 });
    expect(settings.verification).toEqual({ commands: ['just check'], manifests: ['justfile'] });
    expect(settings.context).toEqual({ adaptiveBudget: true });
  });

  it('keeps the other defaults when one nested key is set', async () => {
    const settings = await resolvedWith({ memory: { reflection: { maxTokens: 512 } }, verification: { commands: ['just check'] } });
    expect(settings.memory).toEqual({ reflection: { enabled: false, maxTokens: 512 }, forgetAfterDays: 90 });
    expect(settings.verification).toEqual({ commands: ['just check'], manifests: DEFAULT_MANIFESTS });
  });

  it('lets an empty list turn verified success off', async () => {
    expect((await resolvedWith({ verification: { commands: [] } })).verification).toEqual({ commands: [], manifests: DEFAULT_MANIFESTS });
  });

  it('merges nested keys across layers, a later layer winning each key and replacing a list', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { memory: { forgetAfterDays: 30 }, verification: { commands: ['just check'], manifests: ['justfile'] } });
    writeJson(projectSettingsPath(tree), { memory: { reflection: { enabled: true } }, verification: { commands: ['make verify'] } });
    const { settings } = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(settings.memory).toEqual({ reflection: { enabled: true }, forgetAfterDays: 30 });
    expect(settings.verification).toEqual({ commands: ['make verify'], manifests: ['justfile'] });
  });

  it('ignores project verification settings in an untrusted folder', async () => {
    const tree = makeTree();
    writeJson(projectSettingsPath(tree), { verification: { commands: ['make verify'], manifests: [] } });
    const { settings } = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: distrusting() });
    expect(settings.verification).toEqual({ commands: DEFAULT_COMMANDS, manifests: DEFAULT_MANIFESTS });
  });
});

describe('context settings rejection', () => {
  it.each([
    [{ memory: { extra: 1 } }, '/memory/extra'],
    [{ memory: { reflection: { extra: 1 } } }, '/memory/reflection/extra'],
    [{ verification: { extra: [] } }, '/verification/extra'],
    [{ context: { extra: true } }, '/context/extra'],
    [{ memory: 1 }, '/memory'],
    [{ memory: { reflection: { enabled: 'yes' } } }, '/memory/reflection/enabled'],
    [{ memory: { reflection: { maxTokens: 0 } } }, '/memory/reflection/maxTokens'],
    [{ memory: { reflection: { maxTokens: 1.5 } } }, '/memory/reflection/maxTokens'],
    [{ memory: { forgetAfterDays: 0 } }, '/memory/forgetAfterDays'],
    [{ memory: { forgetAfterDays: '90' } }, '/memory/forgetAfterDays'],
    [{ verification: { commands: 'npm test' } }, '/verification/commands'],
    [{ verification: { commands: [1] } }, '/verification/commands/0'],
    [{ verification: { commands: [''] } }, '/verification/commands/0'],
    [{ verification: { manifests: 'Makefile' } }, '/verification/manifests'],
    [{ verification: { manifests: [''] } }, '/verification/manifests/0'],
    [{ context: { adaptiveBudget: 'no' } }, '/context/adaptiveBudget'],
  ])('rejects %j at its pointer', async (settings, pointer) => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), settings);
    const failure = loadUserSettings({ home: tree.home });
    await expect(failure).rejects.toThrow(file);
    await expect(failure).rejects.toThrow(`invalid settings at ${pointer}:`);
  });
});
