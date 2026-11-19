import { describe, expect, it } from 'vitest';
import type { ModelViews } from '@momonga/protocol';
import { modelOptionOf, selectableModelOf } from '../src/acp/models.ts';

const VIEWS: ModelViews = [
  { canon: 'ollama/gemma-3-4b:latest', provider: 'ollama', ownName: 'gemma-3-4b:latest', defaultTag: 'latest', naming: 'server' },
  { canon: 'lmstudio/gemma-3-4b', provider: 'lmstudio', ownName: 'gemma-3-4b', naming: 'server' },
];

describe('the model option of an ACP session', () => {
  it('offers each configured model with its full reference as the value and its display name as the name', () => {
    expect(modelOptionOf(VIEWS, 'lmstudio/gemma-3-4b')).toEqual({
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'lmstudio/gemma-3-4b',
      options: [
        { value: 'ollama/gemma-3-4b:latest', name: 'ollama/gemma-3-4b' },
        { value: 'lmstudio/gemma-3-4b', name: 'lmstudio/gemma-3-4b' },
      ],
    });
  });

  it('takes the value the client sends back and refuses one that is not configured with the display names', () => {
    expect(selectableModelOf(VIEWS, { configId: 'model', value: 'ollama/gemma-3-4b:latest' })).toBe('ollama/gemma-3-4b:latest');
    expect(() => selectableModelOf(VIEWS, { configId: 'model', value: 'nope' })).toThrow('The model "nope" is not one of the configured models: ollama/gemma-3-4b, lmstudio/gemma-3-4b.');
  });
});
