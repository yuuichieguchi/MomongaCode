import { describe, expect, it } from 'vitest';
import { loadSettings } from '@momonga/config';
import { UNKNOWN_ANSWERER } from '@momonga/protocol';
import { UNKNOWN_ANSWERER as STORE_UNKNOWN_ANSWERER } from '@momonga/store';
import { makeTree, trusting, userSettingsPath, writeJson } from './helpers.ts';

const chatTarget = (): Record<string, unknown> => ({
  adapter: 'chat-completions',
  provider: 'fake',
  model: 'gpt-x',
  baseUrl: 'https://api.example.com/v1',
  capabilities: { contextWindow: 128000, maxOutputTokens: 4096 },
});

const loadWithModels = (models: Record<string, unknown>) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { models });
  return { file: userSettingsPath(tree), loading: loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) }) };
};

describe('the reserved answerer name as a model target name', () => {
  it('is the one name the store records for an unknown answerer', () => {
    expect(UNKNOWN_ANSWERER).toBe('unknown');
    expect(STORE_UNKNOWN_ANSWERER).toBe(UNKNOWN_ANSWERER);
  });

  it('refuses a target named with the reserved name, naming the file, the field and the reservation', async () => {
    const { file, loading } = loadWithModels({ targets: { [UNKNOWN_ANSWERER]: chatTarget() }, aliases: { default: UNKNOWN_ANSWERER } });
    await expect(loading).rejects.toThrow(file);
    await expect(loading).rejects.toThrow(`models.targets.${UNKNOWN_ANSWERER}`);
    await expect(loading).rejects.toThrow(/reserved/);
  });

  it('refuses a target named with the reserved name when no alias points at it', async () => {
    const { file, loading } = loadWithModels({ targets: { real: chatTarget(), [UNKNOWN_ANSWERER]: chatTarget() }, aliases: { default: 'real' } });
    await expect(loading).rejects.toThrow(file);
    await expect(loading).rejects.toThrow(`models.targets.${UNKNOWN_ANSWERER}`);
    await expect(loading).rejects.toThrow(/reserved/);
  });

  it('refuses an alias whose member is the reserved name, naming the alias field and the reservation', async () => {
    const { file, loading } = loadWithModels({ targets: { real: chatTarget() }, aliases: { default: 'real', fast: ['real', UNKNOWN_ANSWERER] } });
    await expect(loading).rejects.toThrow(file);
    await expect(loading).rejects.toThrow('models.aliases.fast');
    await expect(loading).rejects.toThrow(/reserved/);
  });

  it('accepts the same settings once the target has another name', async () => {
    const { loading } = loadWithModels({ targets: { real: chatTarget() }, aliases: { default: 'real' } });
    const result = await loading;
    expect(Object.keys(result.settings.models.targets)).toEqual(['real']);
  });
});
