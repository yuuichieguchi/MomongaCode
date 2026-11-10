import { describe, expect, it } from 'vitest';
import { S1, S2, S3, chatConnection } from './model-fixtures.ts';
import { loadFile, loadModelsSection, sentenceOf } from './load-models.ts';
import type { Chains } from './load-models.ts';

const A = 'srv-a.example.com-443/m';
const B = 'srv-b.example.com-443/m';
const C = 'srv-c.example.com-443/m';

const THREE = [chatConnection('https://a.example.com/v1'), chatConnection('https://b.example.com/v1'), chatConnection('https://c.example.com/v1')];

const chainsOf = (chains: Chains): Record<string, readonly string[]> => Object.fromEntries(chains);

const NOT_CONFIGURED = '"nope" is not a configured model; configured models: devstral-small-2, qwen3.8:27b';

describe('models.start: the model a new session starts with', () => {
  it('is the first model in file order when the key is absent, the named model when written, and absent when no model is configured', async () => {
    expect((await loadFile(S2)).models.start).toBe('ollama/gemma-3-4b:latest');
    expect((await loadModelsSection({ ...S2.models, start: 'lmstudio/gemma-3-4b' })).models.start).toBe('lmstudio/gemma-3-4b');
    const empty = await loadFile({});
    expect(empty.models.start).toBeUndefined();
    expect([...empty.models.models.keys()]).toEqual([]);
    expect(empty.models.views).toEqual([]);
  });

  it('a reference written in a short form is resolved to the full reference; a name two servers hold is refused with both choices', async () => {
    const short = await loadModelsSection({ ...S1.models, start: 'qwen3.8:27b', fallback: ['devstral-small-2'], roles: { compaction: 'ollama/devstral-small-2' } });
    expect(short.models.start).toBe('ollama/qwen3.8:27b');
    expect(short.models.fallback).toEqual(['ollama/devstral-small-2:latest']);
    expect(short.models.roles).toEqual({ compaction: 'ollama/devstral-small-2:latest' });
    expect((await loadModelsSection({ ...S2.models, start: 'ollama/gemma-3-4b' })).models.start).toBe('ollama/gemma-3-4b:latest');
    expect(await sentenceOf({ models: { ...S2.models, start: 'gemma-3-4b' } })).toBe('models.start: "gemma-3-4b" is served by two servers: ollama/gemma-3-4b, lmstudio/gemma-3-4b; write one of them');
  });
});

describe('models.fallback: one ordered list, and the chain of every model', () => {
  it('S3: the plan model falls back to the key model, and the key model has only itself', async () => {
    const { models } = await loadFile(S3);
    expect(models.start).toBe('chatgpt/gpt-5.5');
    expect(models.fallback).toEqual(['openai/gpt-5.5']);
    expect(chainsOf(models.chains)).toEqual({ 'chatgpt/gpt-5.5': ['chatgpt/gpt-5.5', 'openai/gpt-5.5'], 'openai/gpt-5.5': ['openai/gpt-5.5'] });
  });

  it('a chain is the model, then the fallback entries in order, skipping a model already in it', async () => {
    const { models } = await loadModelsSection({ connections: THREE, fallback: [B, A, B] });
    expect(chainsOf(models.chains)).toEqual({ [A]: [A, B], [B]: [B, A], [C]: [C, B, A] });
  });

  it('without a fallback list every chain holds its model alone', async () => {
    const { models } = await loadModelsSection({ connections: THREE });
    expect(models.fallback).toEqual([]);
    expect(chainsOf(models.chains)).toEqual({ [A]: [A], [B]: [B], [C]: [C] });
  });

  it('a reference that names no configured model refuses the file with the sentence of its key', async () => {
    expect(await sentenceOf({ models: { ...S1.models, fallback: ['qwen3.8:27b', 'nope'] } })).toBe(`models.fallback[1]: ${NOT_CONFIGURED}`);
    expect(await sentenceOf({ models: { ...S1.models, roles: { compaction: 'nope' } } })).toBe(`models.roles.compaction: ${NOT_CONFIGURED}`);
    expect(await sentenceOf({ models: S1.models, autoMode: { classifier: 'nope' } })).toBe(`autoMode.classifier: ${NOT_CONFIGURED}`);
    expect(await sentenceOf({ models: { ...S1.models, billingChanges: [{ from: 'local', to: 'metered', model: 'nope' }] } })).toBe(`models.billingChanges[0].model: ${NOT_CONFIGURED}`);
    expect(await sentenceOf({ models: { ...S1.models, start: 'nope' } })).toBe(`models.start: ${NOT_CONFIGURED}`);
    expect(await sentenceOf({ models: { start: 'nope' } })).toBe('models.start: "nope" is not a configured model; no model is configured');
    expect(await sentenceOf({ models: { ...S2.models, roles: { reflection: 'gemma-3-4b' } } })).toBe('models.roles.reflection: "gemma-3-4b" is served by two servers: ollama/gemma-3-4b, lmstudio/gemma-3-4b; write one of them');
  });

  it('a file without models.start loads without a warning: no model is called default', async () => {
    const { warnings, models } = await loadFile(S1);
    expect(models.start).toBe('ollama/devstral-small-2:latest');
    expect(warnings).toEqual([]);
  });

  it('an empty fallback list means the same as no list', async () => {
    const written = await loadModelsSection({ connections: THREE, fallback: [] });
    const absent = await loadModelsSection({ connections: THREE });
    expect(written.models.fallback).toEqual([]);
    expect(chainsOf(written.models.chains)).toEqual(chainsOf(absent.models.chains));
    expect(written.warnings).toEqual(absent.warnings);
  });
});
