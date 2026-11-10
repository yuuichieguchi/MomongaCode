import { describe, expect, it } from 'vitest';
import { loadSettings } from '@momonga/config';
import { connectionOf, makeTree, modelOf, trusting, userSettingsPath, writeJson } from './helpers.ts';

type Adapter = 'anthropic' | 'chat-completions' | 'open-responses' | 'ollama';

const CAPABILITIES = { contextWindow: 32768, maxOutputTokens: 4096 };

const targetOf = (adapter: Adapter, promptCache: unknown): Record<string, unknown> => {
  const capabilities = { ...CAPABILITIES, promptCache };
  switch (adapter) {
    case 'anthropic':
      return { adapter, model: 'claude-fake', baseUrl: 'https://api.example.com', apiKeySecret: 'anthropic-main', capabilities };
    case 'ollama':
      return { adapter, model: 'devstral-small-2', baseUrl: 'http://127.0.0.1:11434', capabilities };
    default:
      return { adapter, provider: 'fake', model: 'gpt-x', baseUrl: 'https://api.example.com/v1', capabilities };
  }
};

const load = (adapter: Adapter, promptCache: unknown) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { models: { connections: [connectionOf('remote', targetOf(adapter, promptCache))] } });
  return { tree, loaded: loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) }) };
};

const BREAKPOINTS = { kind: 'breakpoints', maxBreakpoints: 4 };
const KEY = { kind: 'key' };

const refused: ReadonlyArray<{ adapter: Adapter; promptCache: unknown }> = [
  { adapter: 'chat-completions', promptCache: BREAKPOINTS },
  { adapter: 'open-responses', promptCache: BREAKPOINTS },
  { adapter: 'ollama', promptCache: BREAKPOINTS },
  { adapter: 'ollama', promptCache: KEY },
  { adapter: 'anthropic', promptCache: KEY },
];

const accepted: ReadonlyArray<{ adapter: Adapter; promptCache: unknown }> = [
  { adapter: 'anthropic', promptCache: BREAKPOINTS },
  { adapter: 'chat-completions', promptCache: KEY },
  { adapter: 'open-responses', promptCache: KEY },
  ...(['chat-completions', 'open-responses', 'ollama'] as const).flatMap((adapter) => [
    { adapter, promptCache: { kind: 'automatic' } },
    { adapter, promptCache: { kind: 'none' } },
  ]),
];

const resolvedPromptCache = async (adapter: Adapter, promptCache: unknown): Promise<unknown> => {
  const { settings } = await load(adapter, promptCache).loaded;
  const resolved = modelOf(settings, 'remote');
  return resolved !== undefined && 'capabilities' in resolved ? (resolved.capabilities as { promptCache?: unknown }).promptCache : undefined;
};

describe('the settings accept only the promptCache kinds the target adapter acts on (W4)', () => {
  it.for(refused)('refuses $promptCache.kind on a $adapter target, naming the settings file and the field', async ({ adapter, promptCache }) => {
    const { tree, loaded } = load(adapter, promptCache);
    await expect(loaded).rejects.toThrow(userSettingsPath(tree));
    await expect(loaded).rejects.toThrow(/promptCache/);
  });

  it.for(accepted)('resolves $promptCache.kind on a $adapter target', async ({ adapter, promptCache }) => {
    expect(await resolvedPromptCache(adapter, promptCache)).toEqual(promptCache);
  });
});
