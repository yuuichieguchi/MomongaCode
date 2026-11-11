import { describe, expect, it } from 'vitest';
import { defaultContextSettings, defaultMemorySettings, defaultToolsSettings, loadSettings, loadUserSettings } from '@momonga/config';
import { makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const EVERY_FORMATTER = ['log', 'json', 'grep', 'identicalOutput'];

const ON_CONTEXT = {
  adaptiveBudget: true,
  autoCompact: true,
  cachePrefix: true,
  outputFormatters: EVERY_FORMATTER,
  loopGuidance: true,
  observedCapacity: true,
  unboundedOutputReserve: true,
};
const ON_TOOLS = { deferral: true, conciseDescriptions: true, ripgrep: 'bundled' };
const ON_MEMORY = { reflection: { enabled: true }, forgetAfterDays: 90, repositoryFacts: true };

describe('the defaults of the two core areas are on (design core-on 1, test 1)', () => {
  it('turns every context feature on and lists every output formatter', () => {
    expect(defaultContextSettings()).toEqual(ON_CONTEXT);
  });

  it('turns deferral and concise descriptions on and keeps the bundled ripgrep', () => {
    expect(defaultToolsSettings()).toEqual(ON_TOOLS);
  });

  it('turns reflection and repository facts on and keeps the 90 day window with no token cap', () => {
    expect(defaultMemorySettings()).toEqual(ON_MEMORY);
  });

  it('returns a fresh formatter list each time, so a caller cannot change the next default', () => {
    const first = defaultContextSettings();
    first.outputFormatters.pop();
    expect(defaultContextSettings().outputFormatters).toEqual(EVERY_FORMATTER);
  });
});

describe('loadSettings with the core areas on by default (design core-on 1, test 2)', () => {
  it('resolves the on values when no settings file exists', async () => {
    const tree = makeTree();
    const { settings } = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(settings.context).toEqual(ON_CONTEXT);
    expect(settings.tools).toEqual(ON_TOOLS);
    expect(settings.memory).toEqual(ON_MEMORY);
  });

  it('turns off exactly the keys a user layer turns off', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { context: { outputFormatters: [], cachePrefix: false }, memory: { reflection: { enabled: false } } });
    const { settings } = await loadUserSettings({ home: tree.home, signal: new AbortController().signal });
    expect(settings.context).toEqual({ ...ON_CONTEXT, outputFormatters: [], cachePrefix: false });
    expect(settings.tools).toEqual(ON_TOOLS);
    expect(settings.memory).toEqual({ ...ON_MEMORY, reflection: { enabled: false } });
  });

  it('lets a project layer turn keys off one by one over the user layer', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { context: { cachePrefix: false } });
    writeJson(projectSettingsPath(tree), { context: { outputFormatters: ['log'] }, tools: { deferral: false }, memory: { repositoryFacts: false } });
    const { settings } = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(settings.context).toEqual({ ...ON_CONTEXT, cachePrefix: false, outputFormatters: ['log'] });
    expect(settings.tools).toEqual({ ...ON_TOOLS, deferral: false });
    expect(settings.memory).toEqual({ ...ON_MEMORY, repositoryFacts: false });
  });
});
