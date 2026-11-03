import { describe, expect, it } from 'vitest';
import { MODEL_ROLES, loadSettings, loadUserModels } from '@momonga/config';
import { CALL_ROLES } from '@momonga/protocol';
import { localSettingsPath, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';

const chatTarget = (model: string): Record<string, unknown> => ({
  adapter: 'chat-completions',
  provider: 'fake',
  model,
  baseUrl: 'https://api.example.com/v1',
  capabilities: { contextWindow: 128000, maxOutputTokens: 4096 },
});

const TWO_TARGETS = { main: chatTarget('big'), small: chatTarget('little') };
const ALIASES = { default: 'main', cheap: 'small', judge: ['small', 'main'] };
const ALL_ROLES = { compaction: 'cheap', reflection: 'judge', analysis: 'default' };

describe('the roles a setting can pin', () => {
  it('are a subset of the roles of a model call', () => {
    expect(MODEL_ROLES.every((role) => (CALL_ROLES as readonly string[]).includes(role))).toBe(true);
  });
});

const load = (tree: Tree) => loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });

const loadWithModels = (tree: Tree, models: Record<string, unknown>) => {
  writeJson(userSettingsPath(tree), { models });
  return load(tree);
};

const expectRejected = async (models: Record<string, unknown>, ...fragments: string[]): Promise<void> => {
  const tree = makeTree();
  const failure = loadWithModels(tree, models);
  await expect(failure).rejects.toThrow(userSettingsPath(tree));
  for (const fragment of fragments) await expect(failure).rejects.toThrow(fragment);
};

describe('models.roles in user settings', () => {
  it('guards a lost choice: every role resolves to the alias the person named', async () => {
    const result = await loadWithModels(makeTree(), { targets: TWO_TARGETS, aliases: ALIASES, roles: ALL_ROLES });
    expect(result.settings.models.roles).toEqual(ALL_ROLES);
    expect(result.warnings).toEqual([]);
  });

  it('guards an invented default: with no roles the resolved roles are empty, so every call keeps the run alias', async () => {
    const result = await loadWithModels(makeTree(), { targets: TWO_TARGETS, aliases: ALIASES });
    expect(result.settings.models.roles).toEqual({});
  });

  it('guards a partial setting that fills the other roles: only the named role is set', async () => {
    const result = await loadWithModels(makeTree(), { targets: TWO_TARGETS, aliases: ALIASES, roles: { compaction: 'cheap' } });
    expect(result.settings.models.roles).toEqual({ compaction: 'cheap' });
  });

  it('guards the implicit default alias: a role may name default even when the aliases do not list it', async () => {
    const tree = makeTree();
    const result = await loadWithModels(tree, { targets: TWO_TARGETS, aliases: { cheap: 'small' }, roles: { reflection: 'default' } });
    expect(result.settings.models.roles).toEqual({ reflection: 'default' });
  });

  it('guards the same roles reaching the CLI: loadUserModels carries them', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { models: { targets: TWO_TARGETS, aliases: ALIASES, roles: { analysis: 'cheap' } } });
    expect(loadUserModels({ home: tree.home }).resolved.roles).toEqual({ analysis: 'cheap' });
  });

  it.each(['compaction', 'reflection', 'analysis'])('guards a call sent to nowhere: %s naming an unknown alias is refused with its path', async (role) => {
    await expectRejected({ targets: TWO_TARGETS, aliases: ALIASES, roles: { [role]: 'ghost-alias' } }, `models.roles.${role}`, 'ghost-alias');
  });

  it('guards a role naming a target instead of an alias: a target name is not an alias', async () => {
    await expectRejected({ targets: TWO_TARGETS, aliases: ALIASES, roles: { compaction: 'small' } }, 'models.roles.compaction', 'small');
  });

  it('guards a misspelt role that would be silently ignored: an unknown role is refused', async () => {
    await expectRejected({ targets: TWO_TARGETS, aliases: ALIASES, roles: { planner: 'cheap' } }, 'roles');
  });

  it('guards a second classifier setting: autoMode.classifier is the only one, so a classifier role is refused', async () => {
    await expectRejected({ targets: TWO_TARGETS, aliases: ALIASES, roles: { classifier: 'judge' } }, 'roles');
  });

  it('guards an empty name: a role value must be a non-empty string', async () => {
    await expectRejected({ targets: TWO_TARGETS, aliases: ALIASES, roles: { compaction: '' } }, 'roles');
  });
});

describe('models.roles is user-only', () => {
  it.each([
    ['project', projectSettingsPath],
    ['local', localSettingsPath],
  ] as const)('guards a %s file choosing where data is sent: its roles are dropped with a warning naming the file', async (_label, locate) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { models: { targets: TWO_TARGETS, aliases: ALIASES, roles: { compaction: 'default' } } });
    const file = writeJson(locate(tree), { models: { roles: { compaction: 'cheap', reflection: 'cheap' } } });
    const result = await load(tree);
    expect(result.settings.models.roles).toEqual({ compaction: 'default' });
    expect(result.warnings.some((warning) => warning.includes('models.roles') && warning.includes(file))).toBe(true);
  });
});
