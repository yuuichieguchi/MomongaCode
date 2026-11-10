import { describe, expect, it } from 'vitest';
import { loadUserModels } from '@momonga/config';
import { liveSettingsFor, pinnedModelOf } from '../src/eval/context-host.ts';
import { THREE_DISPLAYS, homeWith, threeModels } from './models-shell-harness.ts';

describe('the settings of a case home', () => {
  it('are written through the writer operations and hold the servers that the chain of the pinned model needs, in the new shape', (context) => {
    const user = loadUserModels({ home: homeWith(context, threeModels({ fallback: ['lmstudio/gemma-3-4b'] })).home });

    const live = liveSettingsFor(user, ['ollama/qwen3.8:27b']);

    expect(live.operations.map((operation) => operation.kind)).toEqual(['addModel', 'addModel', 'setStart', 'setFallback']);
    expect(live.models).not.toHaveProperty('targets');
    expect(live.models).not.toHaveProperty('aliases');
    expect(live.models.connections).toEqual([
      { adapter: 'ollama', baseUrl: 'http://127.0.0.1:11434', billing: 'local', models: [expect.objectContaining({ id: 'qwen3.8:27b' })] },
      { adapter: 'chat-completions', provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', billing: 'local', models: [expect.objectContaining({ id: 'gemma-3-4b' })] },
    ]);
    expect(live.models.start).toBe('ollama/qwen3.8:27b');
    expect(live.models.fallback).toEqual(['lmstudio/gemma-3-4b']);
  });

  it('an unknown --model is refused with the sentence that lists the configured models', (context) => {
    const user = loadUserModels({ home: homeWith(context, threeModels()).home });

    expect(pinnedModelOf(user, 'qwen3.8:27b')).toBe('ollama/qwen3.8:27b');
    expect(() => pinnedModelOf(user, 'nope')).toThrow(`The model "nope" is not configured. Configured models: ${THREE_DISPLAYS}.`);
  });
});
