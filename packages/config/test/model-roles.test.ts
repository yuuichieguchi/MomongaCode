import { describe, expect, it } from 'vitest';
import { MODEL_ROLES, loadSettings, loadUserModels } from '@momonga/config';
import { CALL_ROLES } from '@momonga/protocol';
import { connectionsOf, localSettingsPath, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';

const chatModel = (model: string): Record<string, unknown> => ({
  adapter: 'chat-completions',
  model,
  baseUrl: `https://${model}.example.com/v1`,
  capabilities: { contextWindow: 128000, maxOutputTokens: 4096 },
});

const CONNECTIONS = connectionsOf({ main: chatModel('big'), small: chatModel('little') });
const BIG = 'main/big';
const LITTLE = 'small/little';
const ALL_ROLES = { compaction: 'little', reflection: LITTLE, analysis: 'big' };

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
  it('guards a lost choice: every role resolves to the full reference of the model the person named', async () => {
    const result = await loadWithModels(makeTree(), { connections: CONNECTIONS, roles: ALL_ROLES });
    expect(result.settings.models.roles).toEqual({ compaction: LITTLE, reflection: LITTLE, analysis: BIG });
    expect(result.warnings).toEqual([]);
  });

  it('guards an invented default: with no roles the resolved roles are empty, so every call keeps the model of the session', async () => {
    const result = await loadWithModels(makeTree(), { connections: CONNECTIONS });
    expect(result.settings.models.roles).toEqual({});
  });

  it('guards a partial setting that fills the other roles: only the named role is set', async () => {
    const result = await loadWithModels(makeTree(), { connections: CONNECTIONS, roles: { compaction: LITTLE } });
    expect(result.settings.models.roles).toEqual({ compaction: LITTLE });
  });

  it('guards the same roles reaching the CLI: loadUserModels carries them', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { models: { connections: CONNECTIONS, roles: { analysis: 'little' } } });
    expect(loadUserModels({ home: tree.home }).resolved.roles).toEqual({ analysis: LITTLE });
  });

  it.each(['compaction', 'reflection', 'analysis'])('guards a call sent to nowhere: %s naming a model that is not configured is refused with the sentence of its key', async (role) => {
    await expectRejected({ connections: CONNECTIONS, roles: { [role]: 'ghost-model' } }, `models.roles.${role}: "ghost-model" is not a configured model; configured models: big, little`);
  });

  it('guards a role naming a server instead of a model: a server name is not a model', async () => {
    await expectRejected({ connections: CONNECTIONS, roles: { compaction: 'small' } }, 'models.roles.compaction: "small" is not a configured model; configured models: big, little');
  });

  it('guards a misspelt role that would be silently ignored: an unknown role is refused', async () => {
    await expectRejected({ connections: CONNECTIONS, roles: { planner: LITTLE } }, 'roles');
  });

  it('guards a second classifier setting: autoMode.classifier is the only one, so a classifier role is refused', async () => {
    await expectRejected({ connections: CONNECTIONS, roles: { classifier: LITTLE } }, 'roles');
  });

  it('guards an empty name: a role value must be a non-empty string', async () => {
    await expectRejected({ connections: CONNECTIONS, roles: { compaction: '' } }, 'roles');
  });
});

describe('models.roles is user-only', () => {
  it.each([
    ['project', projectSettingsPath],
    ['local', localSettingsPath],
  ] as const)('guards a %s file choosing where data is sent: its roles are dropped with a warning naming the file', async (_label, locate) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { models: { connections: CONNECTIONS, roles: { compaction: BIG } } });
    const file = writeJson(locate(tree), { models: { roles: { compaction: LITTLE, reflection: LITTLE } } });
    const result = await load(tree);
    expect(result.settings.models.roles).toEqual({ compaction: BIG });
    expect(result.warnings.some((warning) => warning.includes('models.roles') && warning.includes(file))).toBe(true);
  });
});
