import { describe, expect, it } from 'vitest';
import * as config from '@momonga/config';
import { defaultContextSettings, loadSettings, loadUserSettings, mergeContextSettings } from '@momonga/config';
import { COMPACT_AT_PERCENT } from '@momonga/protocol';
import { distrusting, localSettingsPath, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const DEFAULT_MANIFESTS = ['package.json', 'pnpm-lock.yaml', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'Package.swift', 'Makefile'];

const TOKEN_ON = { compactAt: 70, cachePrefix: true, outputFormatters: ['log', 'json', 'grep', 'identicalOutput'], loopGuidance: true, observedCapacity: true, unboundedOutputReserve: true };

const resolvedWith = async (settings: Record<string, unknown>) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), settings);
  return (await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).settings;
};

describe('context settings defaults', () => {
  it('turns reflection on, sets no fixed token cap, and forgets after 90 days', async () => {
    expect((await resolvedWith({})).memory).toEqual({ reflection: { enabled: true }, forgetAfterDays: 90, repositoryFacts: true });
  });

  it('lists the documented verification manifests and no commands, the completion conditions come from the accepted check', async () => {
    expect((await resolvedWith({})).verification).toEqual({ manifests: DEFAULT_MANIFESTS, conditions: [], required: false });
    expect((await resolvedWith({})).verification).not.toHaveProperty('commands');
  });

  it('exports no default verification commands', () => {
    expect(config).not.toHaveProperty('DEFAULT_VERIFICATION_COMMANDS');
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
    const { settings } = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(settings.context).toEqual({ adaptiveBudget: true, autoCompact: true, ...TOKEN_ON });
  });

  it('keeps a lower layer when a later layer does not set it', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { context: { autoCompact: false } });
    writeJson(projectSettingsPath(tree), { context: { adaptiveBudget: true } });
    const { settings } = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(settings.context).toEqual({ adaptiveBudget: true, autoCompact: false, ...TOKEN_ON });
  });
});

describe('context.compactAt', () => {
  it('defaults to 70, the default percent of the compaction mark', async () => {
    expect((await resolvedWith({})).context.compactAt).toBe(70);
    expect(defaultContextSettings().compactAt).toBe(COMPACT_AT_PERCENT.default);
  });

  it('lets a later layer win key by key in mergeContextSettings', () => {
    const base = defaultContextSettings();
    expect(mergeContextSettings(base, { compactAt: 40 })).toEqual({ ...base, compactAt: 40 });
    expect(mergeContextSettings({ ...base, compactAt: 40 }, { autoCompact: false })).toEqual({ ...base, compactAt: 40, autoCompact: false });
    expect(mergeContextSettings({ ...base, compactAt: 40 }, undefined)).toEqual({ ...base, compactAt: 40 });
  });

  it.each([1, 70, 100])('loads %i from a settings file', async (value) => {
    expect((await resolvedWith({ context: { compactAt: value } })).context.compactAt).toBe(value);
  });

  it('takes the user, then the project, then the local layer', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { context: { compactAt: 50 } });
    const load = async () => (await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) })).settings.context.compactAt;
    expect(await load()).toBe(50);
    writeJson(projectSettingsPath(tree), { context: { compactAt: 60 } });
    expect(await load()).toBe(60);
    writeJson(localSettingsPath(tree), { context: { compactAt: 80 } });
    expect(await load()).toBe(80);
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
    const { settings } = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(settings.memory).toEqual({ reflection: { enabled: true }, forgetAfterDays: 30, repositoryFacts: true });
    expect(settings.verification).toEqual({ commands: ['make verify'], manifests: ['justfile'], conditions: ['make verify'], required: false });
  });

  it('ignores project verification settings in an untrusted folder', async () => {
    const tree = makeTree();
    writeJson(projectSettingsPath(tree), { verification: { commands: ['make verify'], manifests: [] } });
    const { settings } = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: distrusting() });
    expect(settings.verification).toEqual({ manifests: DEFAULT_MANIFESTS, conditions: [], required: false });
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
    [{ context: { compactAt: 0 } }, '/context/compactAt'],
    [{ context: { compactAt: 101 } }, '/context/compactAt'],
    [{ context: { compactAt: 70.5 } }, '/context/compactAt'],
    [{ context: { compactAt: '70' } }, '/context/compactAt'],
    [{ context: { compactAt: -1 } }, '/context/compactAt'],
  ])('rejects %j at its pointer', async (settings, pointer) => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), settings);
    const failure = loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal });
    await expect(failure).rejects.toThrow(file);
    await expect(failure).rejects.toThrow(`invalid settings at ${pointer}:`);
  });
});
