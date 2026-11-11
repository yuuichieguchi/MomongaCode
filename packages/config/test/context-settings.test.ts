import { describe, expect, it } from 'vitest';
import { loadSettings, loadUserSettings } from '@momonga/config';
import { distrusting, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const DEFAULT_COMMANDS = ['npm test', 'pnpm test', 'yarn test', 'cargo test', 'pytest', 'go test ./...', 'swift test', 'make test'];
const DEFAULT_MANIFESTS = ['package.json', 'pnpm-lock.yaml', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'Package.swift', 'Makefile'];

const TOKEN_ON = { cachePrefix: true, outputFormatters: ['log', 'json', 'grep', 'identicalOutput'], loopGuidance: true, observedCapacity: true, unboundedOutputReserve: true };

const resolvedWith = async (settings: Record<string, unknown>) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), settings);
  return (await loadUserSettings({ home: tree.home, signal: new AbortController().signal })).settings;
};

describe('context settings defaults', () => {
  it('turns reflection on, sets no fixed token cap, and forgets after 90 days', async () => {
    expect((await resolvedWith({})).memory).toEqual({ reflection: { enabled: true }, forgetAfterDays: 90, repositoryFacts: true });
  });

  it('lists the documented verification commands and manifests', async () => {
    expect((await resolvedWith({})).verification).toEqual({ commands: DEFAULT_COMMANDS, manifests: DEFAULT_MANIFESTS, conditions: [], required: false });
  });

  it('keeps the adaptive budget and automatic compaction on', async () => {
    expect((await resolvedWith({})).context).toEqual({ adaptiveBudget: true, autoCompact: true, ...TOKEN_ON });
  });
});

describe('context.autoCompact', () => {
  it('resolves false from the user settings', async () => {
    expect((await resolvedWith({ context: { autoCompact: false } })).context).toEqual({ adaptiveBudget: true, autoCompact: false, ...TOKEN_ON });
  });

  it('lets a later layer win without touching the other key', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { context: { autoCompact: false, adaptiveBudget: true } });
    writeJson(projectSettingsPath(tree), { context: { autoCompact: true } });
    const { settings } = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(settings.context).toEqual({ adaptiveBudget: true, autoCompact: true, ...TOKEN_ON });
  });

  it('keeps a lower layer when a later layer does not set it', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { context: { autoCompact: false } });
    writeJson(projectSettingsPath(tree), { context: { adaptiveBudget: true } });
    const { settings } = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(settings.context).toEqual({ adaptiveBudget: true, autoCompact: false, ...TOKEN_ON });
  });
});

describe('context settings values', () => {
  it('resolves every key the user sets', async () => {
    const settings = await resolvedWith({
      memory: { reflection: { enabled: true, maxTokens: 512 }, forgetAfterDays: 30 },
      verification: { commands: ['just check'], manifests: ['justfile'] },
      context: { adaptiveBudget: true },
    });
    expect(settings.memory).toEqual({ reflection: { enabled: true, maxTokens: 512 }, forgetAfterDays: 30, repositoryFacts: true });
    expect(settings.verification).toEqual({ commands: ['just check'], manifests: ['justfile'], conditions: ['just check'], required: false });
    expect(settings.context).toEqual({ adaptiveBudget: true, autoCompact: true, ...TOKEN_ON });
  });

  it('keeps the other defaults when one nested key is set', async () => {
    const settings = await resolvedWith({ memory: { reflection: { maxTokens: 512 } }, verification: { commands: ['just check'] } });
    expect(settings.memory).toEqual({ reflection: { enabled: true, maxTokens: 512 }, forgetAfterDays: 90, repositoryFacts: true });
    expect(settings.verification).toEqual({ commands: ['just check'], manifests: DEFAULT_MANIFESTS, conditions: ['just check'], required: false });
  });

  it('lets an empty list turn verified success off', async () => {
    expect((await resolvedWith({ verification: { commands: [] } })).verification).toEqual({ commands: [], manifests: DEFAULT_MANIFESTS, conditions: [], required: false });
  });

  it('merges nested keys across layers, a later layer winning each key and replacing a list', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { memory: { forgetAfterDays: 30 }, verification: { commands: ['just check'], manifests: ['justfile'] } });
    writeJson(projectSettingsPath(tree), { memory: { reflection: { enabled: true } }, verification: { commands: ['make verify'] } });
    const { settings } = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(settings.memory).toEqual({ reflection: { enabled: true }, forgetAfterDays: 30, repositoryFacts: true });
    expect(settings.verification).toEqual({ commands: ['make verify'], manifests: ['justfile'], conditions: ['make verify'], required: false });
  });

  it('ignores project verification settings in an untrusted folder', async () => {
    const tree = makeTree();
    writeJson(projectSettingsPath(tree), { verification: { commands: ['make verify'], manifests: [] } });
    const { settings } = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: distrusting() });
    expect(settings.verification).toEqual({ commands: DEFAULT_COMMANDS, manifests: DEFAULT_MANIFESTS, conditions: [], required: false });
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
    [{ context: { autoCompact: 'no' } }, '/context/autoCompact'],
  ])('rejects %j at its pointer', async (settings, pointer) => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), settings);
    const failure = loadUserSettings({ home: tree.home, signal: new AbortController().signal });
    await expect(failure).rejects.toThrow(file);
    await expect(failure).rejects.toThrow(`invalid settings at ${pointer}:`);
  });
});
