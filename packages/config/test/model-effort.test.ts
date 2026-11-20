import { describe, expect, it } from 'vitest';
import { chatConnection } from './model-fixtures.ts';
import { loadFile, refusalOf } from './load-models.ts';

const ADDRESS = 'http://127.0.0.1:8080/v1';

const reasoningEntry = (id: string, effort: string | undefined) => ({
  id,
  capabilities: { contextWindow: 8192, maxOutputTokens: 1024, reasoning: { control: 'reasoning_effort', lowest: 'low' } },
  ...(effort === undefined ? {} : { effort }),
});

const connectionWith = (entries: readonly Record<string, unknown>[]) => ({ ...chatConnection(ADDRESS), models: entries });

describe('the effort a model entry saves for itself', () => {
  it('loads the level of each entry into the resolved models by the Canon of the model, apart from its target', async () => {
    const { models } = await loadFile({ models: { connections: [connectionWith([reasoningEntry('a', 'high'), reasoningEntry('b', undefined)])], effort: 'low' } });
    const [a, b] = models.views;
    expect(models.efforts.get(a?.canon ?? '')).toBe('high');
    expect(models.efforts.has(b?.canon ?? '')).toBe(false);
    expect(models.effort).toBe('low');
    expect(models.models.get(a?.canon ?? '')).not.toHaveProperty('effort');
  });

  it('refuses a word that is not a level, at the pointer of the entry', async () => {
    const { message } = await refusalOf({ models: { connections: [connectionWith([reasoningEntry('a', 'huge')])] } });
    expect(message).toMatch(/invalid settings at \/models\/connections\/0\/models\/0\/effort/);
  });

  it('refuses a level the declared reasoning of the model does not accept, naming the levels it accepts', async () => {
    const { message } = await refusalOf({ models: { connections: [connectionWith([reasoningEntry('a', 'minimal')])] } });
    expect(message).toMatch(/models\.connections\[0\]\.models\[0\]: effort minimal is not a level capabilities\.reasoning accepts; accepted: low, medium, high/);
  });

  it('keeps the level of an entry whose written capabilities say nothing of reasoning, whatever its adapter', async () => {
    const declared = await loadFile({ models: { connections: [connectionWith([{ id: 'a', capabilities: { contextWindow: 8192, maxOutputTokens: 1024 }, effort: 'high' }])] } });
    const idOnly = await loadFile({ models: { connections: [{ adapter: 'ollama', provider: 'ollama-127.0.0.1-18477', baseUrl: 'http://127.0.0.1:18477', models: [{ id: 'think-c:latest', effort: 'high' }] }] } });
    expect([declared, idOnly].map(({ models }) => models.efforts.get(models.views[0]?.canon ?? ''))).toEqual(['high', 'high']);
  });
});
