import { describe, expect, it } from 'vitest';
import { S1, S2H, S3, S4 } from './model-fixtures.ts';
import { loadFile, loadModelsSection } from './load-models.ts';

const namingsOf = async (document: unknown): Promise<Record<string, string>> =>
  Object.fromEntries((await loadFile(document)).models.views.map((view) => [view.canon, view.naming]));

describe('a model is named by its server or by its own name, from facts of its connection', () => {
  it('a local server, a second server at another address and a declared program are named by their server', async () => {
    expect(await namingsOf(S1)).toEqual({ 'ollama/devstral-small-2:latest': 'server', 'ollama/qwen3.8:27b': 'server' });
    expect(await namingsOf(S2H)).toEqual({ 'ollama/gemma-3-4b:latest': 'server', 'srv-127.0.0.1-1234/gemma-3-4b': 'server' });
    expect(await namingsOf(S4)).toEqual({ 'llama-server/qwen3-coder-30b': 'server' });
  });

  it('the built-in Apple server is named by its server', async () => {
    const { models } = await loadModelsSection({ connections: [{ adapter: 'managed', server: 'fm', models: [{ id: 'x' }] }] });
    expect(models.views.map((view) => view.naming)).toEqual(['server']);
  });

  it('a plan account and a hosted provider reached with a key are named by the model own name', async () => {
    expect(await namingsOf(S3)).toEqual({ 'chatgpt/gpt-5.5': 'account', 'openai/gpt-5.5': 'account' });
  });
});
