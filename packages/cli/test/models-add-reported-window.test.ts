import { describe, expect, it } from 'vitest';
import { runModelsForm } from '../src/commands/models.ts';
import { OLLAMA_ADDRESS, documentOf, homeWith, ollamaFound, shellOf } from './models-shell-harness.ts';

describe('models add writes for an Ollama model only the window the person gives', () => {
  it('adds an Ollama model with no --window without a window, whatever context length the server reports', async (context) => {
    const place = homeWith(context, undefined);
    const described: string[] = [];
    const harness = shellOf(place, {
      found: () => [ollamaFound(OLLAMA_ADDRESS, ['qwen3.8:27b'])],
      describe: async (_server, model) => {
        described.push(model.id);
        return { ...model, tools: 'yes', ceiling: 40_960 };
      },
    });

    expect(await runModelsForm(harness.shell, 'add', { args: [], options: { model: 'qwen3.8:27b', yes: true } })).toBe(0);

    expect(described).toEqual(['qwen3.8:27b']);
    expect(documentOf(place.settingsFile)).toMatchObject({ models: { connections: [{ adapter: 'ollama', baseUrl: OLLAMA_ADDRESS }] } });
    expect((documentOf(place.settingsFile)['models'] as { connections: { models: unknown[] }[] }).connections[0]?.models).toEqual([{ id: 'qwen3.8:27b' }]);
  });
});
