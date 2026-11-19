import { describe, expect, it } from 'vitest';
import { ModelRefError, modelRefErrorOf, resolveTypedModelRef, typedModelText } from '../src/index.ts';
import type { Surface, TypedResolution } from '../src/index.ts';
import { CANON_EQUAL, S1, S2, SLASH_ID, view } from './model-ref-fixtures.ts';
import type { View } from './model-ref-fixtures.ts';

const typed = (text: string, views: readonly View[]): TypedResolution => resolveTypedModelRef(typedModelText(text), views);

const canonOfFound = (text: string, views: readonly View[]): string => {
  const resolution = typed(text, views);
  if (resolution.kind !== 'found') throw new Error(`${JSON.stringify(text)} resolved as ${resolution.kind}`);
  return resolution.model.canon;
};

const refusalOf = (text: string, views: readonly View[], surface: Surface = 'tui'): ModelRefError => {
  const resolution = typed(text, views);
  if (resolution.kind === 'found') throw new Error(`${JSON.stringify(text)} resolved to ${resolution.model.canon}`);
  return modelRefErrorOf(text, resolution, views, surface);
};

const serversOf = (names: readonly string[]): View[] => names.map((name) => view(name, 'x'));

describe('resolveTypedModelRef: a text a person wrote', () => {
  it('S1: the short form, the own name, and each with the server name in front give the one model', () => {
    expect(['devstral-small-2', 'devstral-small-2:latest', 'ollama/devstral-small-2', 'ollama/devstral-small-2:latest'].map((text) => canonOfFound(text, S1))).toEqual([
      'ollama/devstral-small-2:latest',
      'ollama/devstral-small-2:latest',
      'ollama/devstral-small-2:latest',
      'ollama/devstral-small-2:latest',
    ]);
  });

  it('S2: a text that only one model holds, or that names its server, gives that model', () => {
    expect(['ollama/gemma-3-4b', 'ollama/gemma-3-4b:latest', 'gemma-3-4b:latest'].map((text) => canonOfFound(text, S2))).toEqual(['ollama/gemma-3-4b:latest', 'ollama/gemma-3-4b:latest', 'ollama/gemma-3-4b:latest']);
    expect(canonOfFound('lmstudio/gemma-3-4b', S2)).toBe('lmstudio/gemma-3-4b');
  });

  it('S2: the bare name held by two servers is ambiguous, with both choices in file order', () => {
    const resolution = typed('gemma-3-4b', S2);
    expect(resolution.kind).toBe('ambiguous');
    expect(resolution.kind === 'ambiguous' ? resolution.choices.map((choice) => choice.canon) : []).toEqual(['ollama/gemma-3-4b:latest', 'lmstudio/gemma-3-4b']);
  });

  it('S2 without the LM Studio server: the bare name resolves, and the result is the member of the views', () => {
    const [ollama] = S2;
    const resolution = typed('gemma-3-4b', [ollama as View]);
    expect(resolution).toEqual({ kind: 'found', model: ollama });
    expect(resolution.kind === 'found' ? resolution.model : undefined).toBe(ollama);
  });

  it('an own name with a slash resolves alone and with its server name in front', () => {
    expect(canonOfFound('google/gemma-3n-e4b', SLASH_ID)).toBe('lmstudio/google/gemma-3n-e4b');
    expect(canonOfFound('lmstudio/google/gemma-3n-e4b', SLASH_ID)).toBe('lmstudio/google/gemma-3n-e4b');
  });

  it('a text equal to a canonical reference gives that model, not the model whose own name is that text', () => {
    expect(canonOfFound('lmstudio/x', CANON_EQUAL)).toBe('lmstudio/x');
  });

  it('a text no model holds is not found: nothing is guessed from a part of a name or another case', () => {
    expect(['nope', 'devstral', 'Devstral-Small-2'].map((text) => typed(text, S1))).toEqual([{ kind: 'not_found' }, { kind: 'not_found' }, { kind: 'not_found' }]);
  });

  it('with no model configured every text is not found', () => {
    expect(typed('devstral-small-2', [])).toEqual({ kind: 'not_found' });
  });
});

describe('modelRefErrorOf: the one sentence of each refusal', () => {
  it('two servers', () => {
    const error = refusalOf('gemma-3-4b', S2);
    expect(error).toBeInstanceOf(ModelRefError);
    expect(error.message).toBe('The model "gemma-3-4b" is served by two servers: ollama/gemma-3-4b, lmstudio/gemma-3-4b. Write one of them.');
    expect({ code: error.code, text: error.text, choices: error.choices }).toEqual({ code: 'ambiguous_model', text: 'gemma-3-4b', choices: ['ollama/gemma-3-4b', 'lmstudio/gemma-3-4b'] });
  });

  it('three servers', () => {
    expect(refusalOf('x', serversOf(['a', 'b', 'c'])).message).toBe('The model "x" is served by three servers: a/x, b/x, c/x. Write one of them.');
  });

  it('four servers are counted in digits', () => {
    expect(refusalOf('x', serversOf(['a', 'b', 'c', 'd'])).message).toBe('The model "x" is served by 4 servers: a/x, b/x, c/x, d/x. Write one of them.');
  });

  it('not found with models configured lists their display names', () => {
    const error = refusalOf('nope', S1);
    expect(error.message).toBe('The model "nope" is not configured. Configured models: ollama/devstral-small-2, ollama/qwen3.8:27b.');
    expect({ code: error.code, text: error.text, choices: error.choices }).toEqual({ code: 'model_not_found', text: 'nope', choices: ['ollama/devstral-small-2', 'ollama/qwen3.8:27b'] });
  });

  it('not found with no model configured says how to connect one', () => {
    expect(refusalOf('nope', []).message).toBe('The model "nope" is not configured. No model is connected. Use /login to sign in or add an API key, or /model to use a local server.');
  });

  it('not found with no model configured names a shell command where the reader is in a shell', () => {
    expect(refusalOf('nope', [], 'cli').message).toBe('The model "nope" is not configured. No model is connected. Run momonga models add to add one, or momonga auth login to sign in.');
    expect(refusalOf('nope', [], 'gateway').message).not.toContain('/login');
  });
});
