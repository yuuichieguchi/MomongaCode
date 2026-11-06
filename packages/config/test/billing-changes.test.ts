import { describe, expect, it } from 'vitest';
import { loadSettings, loadUserSettings } from '@momonga/config';
import { makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const CAPABILITIES = { contextWindow: 200000, maxOutputTokens: 8192 };

const metered = { adapter: 'open-responses', provider: 'fake', model: 'm', baseUrl: 'https://example.com/v1', capabilities: CAPABILITIES };
const local = { adapter: 'ollama', model: 'm', baseUrl: 'http://127.0.0.1:11434', capabilities: CAPABILITIES };
const plan = { adapter: 'open-responses', model: 'gpt-fake', plan: { profile: 'chatgpt' }, capabilities: CAPABILITIES };

const TARGETS = { remote: metered, home: local, sub: plan, other: { ...metered, model: 'n' } };

const loadUser = async (models: Record<string, unknown>) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { models });
  return { tree, result: await loadUserSettings({ home: tree.home }) };
};

const expectRejected = async (models: Record<string, unknown>, ...fragments: Array<string | RegExp>): Promise<void> => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { models });
  const failure = loadUserSettings({ home: tree.home });
  await expect(failure).rejects.toThrow(userSettingsPath(tree));
  for (const fragment of fragments) await expect(failure).rejects.toThrow(fragment);
};

const billingWarnings = (warnings: readonly string[]): string[] => warnings.filter((warning) => warning.includes('billingChanges'));

describe('models.billingChanges', () => {
  it('resolves to the declared list', async () => {
    const changes = [{ from: 'local', to: 'metered' }, { from: 'metered', to: 'plan', alias: 'default' }];
    const { result } = await loadUser({ targets: TARGETS, aliases: { default: 'remote' }, billingChanges: changes });
    expect(result.settings.models.billingChanges).toEqual(changes);
  });

  it('resolves to an empty list when absent, so no change of who pays is allowed', async () => {
    const { result } = await loadUser({ targets: TARGETS, aliases: { default: 'remote' } });
    expect(result.settings.models.billingChanges).toEqual([]);
  });

  it('refuses a pair whose from equals its to', async () => {
    await expectRejected({ targets: TARGETS, aliases: { default: 'remote' }, billingChanges: [{ from: 'plan', to: 'plan' }] }, /billingChanges/, /plan/);
  });

  it('refuses an alias that is not declared', async () => {
    await expectRejected({ targets: TARGETS, aliases: { default: 'remote' }, billingChanges: [{ from: 'local', to: 'metered', alias: 'nowhere' }] }, /billingChanges/, /nowhere/);
  });

  it('accepts an alias that is the implicit default alias', async () => {
    const { result } = await loadUser({ targets: { remote: metered }, billingChanges: [{ from: 'local', to: 'metered', alias: 'default' }] });
    expect(result.settings.models.billingChanges).toEqual([{ from: 'local', to: 'metered', alias: 'default' }]);
  });

  it('refuses a billing kind it does not know', async () => {
    await expectRejected({ targets: TARGETS, aliases: { default: 'remote' }, billingChanges: [{ from: 'free', to: 'metered' }] }, /billingChanges/);
  });

  it('refuses an entry that is not a pair', async () => {
    await expectRejected({ targets: TARGETS, aliases: { default: 'remote' }, billingChanges: [{ from: 'local' }] }, /billingChanges/);
    await expectRejected({ targets: TARGETS, aliases: { default: 'remote' }, billingChanges: [{ from: 'local', to: 'metered', also: 1 }] }, /billingChanges/);
  });
});

describe('models.billingChanges in a project settings file', () => {
  it('is discarded with a warning that names the file, and the other models keys stay', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { models: { targets: { remote: metered }, aliases: { default: 'remote' } } });
    writeJson(projectSettingsPath(tree), { models: { billingChanges: [{ from: 'local', to: 'metered' }] } });
    const loaded = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(loaded.settings.models.billingChanges).toEqual([]);
    expect(loaded.warnings.some((warning) => warning.includes('models.billingChanges is only honored in user settings') && warning.includes(projectSettingsPath(tree)))).toBe(true);
  });
});

describe('the load warning for aliases that would change who pays', () => {
  it('names an alias whose adjacent members differ in billing and have no allowed pair', async () => {
    const { result } = await loadUser({ targets: TARGETS, aliases: { default: ['home', 'remote'] } });
    const [warning, ...rest] = billingWarnings(result.warnings);
    expect(rest).toEqual([]);
    expect(warning).toContain('models.aliases.default');
    expect(warning).toContain('local');
    expect(warning).toContain('metered');
  });

  it('is silent once the user allows the pair', async () => {
    const { result } = await loadUser({ targets: TARGETS, aliases: { default: ['home', 'remote'] }, billingChanges: [{ from: 'local', to: 'metered' }] });
    expect(billingWarnings(result.warnings)).toEqual([]);
  });

  it('still warns when the allowed pair is scoped to another alias', async () => {
    const { result } = await loadUser({
      targets: TARGETS,
      aliases: { default: ['home', 'remote'], elsewhere: 'remote' },
      billingChanges: [{ from: 'local', to: 'metered', alias: 'elsewhere' }],
    });
    expect(billingWarnings(result.warnings)).toHaveLength(1);
  });

  it('treats the direction of the pair as part of it', async () => {
    const { result } = await loadUser({ targets: TARGETS, aliases: { default: ['remote', 'home'] }, billingChanges: [{ from: 'local', to: 'metered' }] });
    expect(billingWarnings(result.warnings)).toHaveLength(1);
  });

  it('covers a plan member by the same rule, in either direction', async () => {
    const { result } = await loadUser({ targets: TARGETS, aliases: { default: ['sub', 'remote'], back: ['remote', 'sub'] } });
    const warnings = billingWarnings(result.warnings);
    expect(warnings).toHaveLength(2);
    expect(warnings.some((warning) => warning.includes('models.aliases.default') && warning.includes('plan') && warning.includes('metered'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('models.aliases.back'))).toBe(true);
  });

  it('is silent for members of one billing kind and for a single member', async () => {
    const { result } = await loadUser({ targets: TARGETS, aliases: { default: ['remote', 'other'], solo: 'home' } });
    expect(billingWarnings(result.warnings)).toEqual([]);
  });
});
