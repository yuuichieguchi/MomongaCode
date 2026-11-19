import { describe, expect, it } from 'vitest';
import { displayMapOf } from '../src/index.ts';
import { OLLAMA_TAG, serverView, view } from './model-ref-fixtures.ts';
import type { View } from './model-ref-fixtures.ts';

const shown = (views: readonly View[]): string[] => [...displayMapOf(views).values()];

describe('one name for a model on every surface', () => {
  it.each([
    ['a local server at its own address', [serverView('ollama', 'qwen3.8:27b', OLLAMA_TAG)], ['ollama/qwen3.8:27b']],
    ['a second server of the same software', [serverView('ollama', 'qwen3.8:27b', OLLAMA_TAG), serverView('ollama-192.168.1.20-11434', 'gemma-3-4b:latest', OLLAMA_TAG)], ['ollama/qwen3.8:27b', 'ollama-192.168.1.20-11434/gemma-3-4b']],
    ['an LM Studio own name holding a slash', [serverView('lmstudio', 'google/gemma-3n-e4b')], ['lmstudio/google/gemma-3n-e4b']],
    ['a declared program', [serverView('mlx', 'qwen3-coder')], ['mlx/qwen3-coder']],
    ['the built-in Apple server', [serverView('apple', 'system')], ['apple/system']],
    ['a plan model whose name is unique', [serverView('ollama', 'qwen3.8:27b', OLLAMA_TAG), view('chatgpt', 'gpt-6-luna')], ['ollama/qwen3.8:27b', 'gpt-6-luna']],
    ['a plan model in two accounts', [view('chatgpt', 'gpt-6-luna'), view('chatgpt-2', 'gpt-6-luna')], ['chatgpt/gpt-6-luna', 'chatgpt-2/gpt-6-luna']],
    ['a plan model and an API-key model of one name', [view('chatgpt', 'gpt-5.5'), view('openai', 'gpt-5.5')], ['chatgpt/gpt-5.5', 'openai/gpt-5.5']],
    ['a hosted model whose name is unique', [view('openai', 'gpt-5.5')], ['gpt-5.5']],
    ['an Ollama model tagged latest', [serverView('ollama', 'devstral-small-2:latest', OLLAMA_TAG)], ['ollama/devstral-small-2']],
    ['a plan model whose name a local server also serves', [serverView('ollama', 'gpt-oss:20b', OLLAMA_TAG), view('chatgpt', 'gpt-oss:20b')], ['ollama/gpt-oss:20b', 'chatgpt/gpt-oss:20b']],
  ] as const)('%s', (_case, views, names) => {
    expect(shown(views)).toEqual(names);
  });
});
