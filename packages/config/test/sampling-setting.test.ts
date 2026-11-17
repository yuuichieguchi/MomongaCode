import { describe, expect, it } from 'vitest';
import { loadSettings } from '@momonga/config';
import { connectionOf, makeTree, modelOf, trusting, userSettingsPath, writeJson } from './helpers.ts';

type SamplingAdapter = 'anthropic' | 'chat-completions' | 'open-responses' | 'ollama';

const ADAPTERS_THAT_RENDER_SAMPLING: readonly SamplingAdapter[] = ['anthropic', 'chat-completions', 'open-responses', 'ollama'];

const CAPABILITIES = { contextWindow: 32768, maxOutputTokens: 4096 };

const targetOf = (adapter: SamplingAdapter, sampling: unknown): Record<string, unknown> => {
  const capabilities = { ...CAPABILITIES, sampling };
  switch (adapter) {
    case 'anthropic':
      return { adapter, model: 'model-a', baseUrl: 'https://api.example.com', apiKeySecret: 'anthropic-main', apiVersion: '2023-06-01', capabilities };
    case 'ollama':
      return { adapter, model: 'model-a', baseUrl: 'http://127.0.0.1:11434', capabilities };
    default:
      return { adapter, provider: 'fake', model: 'model-a', baseUrl: 'https://api.example.com/v1', capabilities };
  }
};

const settingsWith = (target: Record<string, unknown>) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { models: { connections: [connectionOf('remote', target)] } });
  return { tree, loaded: loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) }) };
};

const DECLARATIONS = [
  { accepts: 'none' },
  { accepts: 'without_thinking', topP: { min: 0.95, max: 1 } },
  { accepts: 'free' },
];

const MALFORMED: ReadonlyArray<{ label: string; sampling: unknown; fragment: string }> = [
  { label: 'an unknown acceptance', sampling: { accepts: 'sometimes' }, fragment: 'sampling' },
  { label: 'without_thinking with no top_p range', sampling: { accepts: 'without_thinking' }, fragment: 'sampling' },
  { label: 'a top_p range above 1', sampling: { accepts: 'without_thinking', topP: { min: 0.95, max: 1.5 } }, fragment: 'sampling' },
  { label: 'a top_p range below 0', sampling: { accepts: 'without_thinking', topP: { min: -0.1, max: 1 } }, fragment: 'sampling' },
  { label: 'a top_p range whose min exceeds its max', sampling: { accepts: 'without_thinking', topP: { min: 0.99, max: 0.95 } }, fragment: 'topP' },
  { label: 'a top_p range on the free acceptance', sampling: { accepts: 'free', topP: { min: 0.95, max: 1 } }, fragment: 'sampling' },
];

describe('declared sampling acceptance on the adapters that render sampling parameters', () => {
  it.for(ADAPTERS_THAT_RENDER_SAMPLING.flatMap((adapter) => DECLARATIONS.map((sampling) => ({ adapter, sampling, name: `${adapter} accepts ${sampling.accepts}` }))))(
    '$name',
    async ({ adapter, sampling }) => {
      const { settings } = await settingsWith(targetOf(adapter, sampling)).loaded;
      expect(modelOf(settings, 'remote')).toMatchObject({ capabilities: { sampling } });
    },
  );

  it.for(ADAPTERS_THAT_RENDER_SAMPLING)('%s without a sampling declaration resolves with none, so values are forwarded as today', async (adapter) => {
    const target = targetOf(adapter, undefined);
    const { settings } = await settingsWith({ ...target, capabilities: CAPABILITIES }).loaded;
    expect((modelOf(settings, 'remote') as unknown as { capabilities: Record<string, unknown> }).capabilities['sampling']).toBeUndefined();
  });
});

describe('a malformed sampling declaration is refused, naming the target and the field', () => {
  it.for(ADAPTERS_THAT_RENDER_SAMPLING.flatMap((adapter) => MALFORMED.map((entry) => ({ adapter, ...entry, name: `${adapter}: ${entry.label}` }))))(
    '$name',
    async ({ adapter, sampling, fragment }) => {
      const { tree, loaded } = settingsWith(targetOf(adapter, sampling));
      await expect(loaded).rejects.toThrow(userSettingsPath(tree));
      await expect(loaded).rejects.toThrow(/models[./]connections[[/]0/);
      await expect(loaded).rejects.toThrow('sampling');
      await expect(loaded).rejects.toThrow(fragment);
    },
  );
});
