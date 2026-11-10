import { describe, expect, it } from 'vitest';
import { canonOf, displayMapOf, displayOf, parseCanon, shortOf } from '../src/index.ts';
import { CANON_EQUAL, OLLAMA_TAG, S1, S2, S2H, S3, SLASH_ID, view } from './model-ref-fixtures.ts';
import type { View } from './model-ref-fixtures.ts';

const displaysOf = (views: readonly View[]): string[] => views.map((entry) => displayOf(entry, views));

describe('the canonical reference of a model: server name, a slash, the own name', () => {
  it('canonOf joins the server name and the own name with one slash', () => {
    expect(canonOf('ollama', 'qwen3:8b')).toBe('ollama/qwen3:8b');
  });

  it('parseCanon splits at the first slash, so an own name keeps its slashes', () => {
    expect(parseCanon('lmstudio/google/gemma-3n-e4b')).toEqual({ provider: 'lmstudio', ownName: 'google/gemma-3n-e4b' });
  });

  it('parseCanon keeps a leading slash of the own name', () => {
    expect(parseCanon('p//x')).toEqual({ provider: 'p', ownName: '/x' });
  });

  it('parseCanon gives nothing for a text without a slash', () => {
    expect(parseCanon('nope')).toBeUndefined();
  });

  it('parseCanon gives nothing when the part before the first slash is not a server name', () => {
    expect(parseCanon('Bad/x')).toBeUndefined();
  });

  it('parseCanon gives nothing when the own name is empty', () => {
    expect(parseCanon('p/')).toBeUndefined();
  });
});

describe('the short form of an own name (the default tag left out)', () => {
  it('exists exactly for an own name that ends in the default tag of its server kind', () => {
    const shortUnderOllama = (ownName: string): string | undefined => shortOf(view('ollama', ownName, OLLAMA_TAG));
    expect(shortUnderOllama('devstral-small-2:latest')).toBe('devstral-small-2');
    expect(shortUnderOllama('example/model:latest')).toBe('example/model');
    expect(shortUnderOllama('x:latest:latest')).toBe('x:latest');
    expect(['qwen3.8:27b', 'example/model:7b', 'google/gemma', ':latest', 'a:latest/b', 'x:Latest', 'x:'].map(shortUnderOllama)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
  });

  it('never exists on a server whose kind has no default tag', () => {
    expect(shortOf(view('lmstudio', 'x:latest'))).toBeUndefined();
  });
});

describe('the display name of a configured model', () => {
  it('S1, one Ollama server: the short form, or the own name when it has no short form', () => {
    expect(displaysOf(S1)).toEqual(['devstral-small-2', 'qwen3.8:27b']);
  });

  it('S2, Ollama and LM Studio serving one name: the server name in front of the short form and of the own name', () => {
    expect(displaysOf(S2)).toEqual(['ollama/gemma-3-4b', 'lmstudio/gemma-3-4b']);
  });

  it('S2 written by hand: the derived server name in front', () => {
    expect(displaysOf(S2H)).toEqual(['ollama/gemma-3-4b', 'srv-127.0.0.1-1234/gemma-3-4b']);
  });

  it('S3, a plan account and a key serving one name', () => {
    expect(displaysOf(S3)).toEqual(['chatgpt/gpt-5.5', 'openai/gpt-5.5']);
  });

  it('an own name with a slash on one server is shown alone', () => {
    expect(displaysOf(SLASH_ID)).toEqual(['google/gemma-3n-e4b']);
  });

  it('a model whose own name equals another model canonical reference is shown by its own canonical reference', () => {
    expect(displaysOf(CANON_EQUAL)).toEqual(['x', 'srv-a-1/lmstudio/x']);
  });
});

describe('displayMapOf gives for every view the text displayOf gives', () => {
  it.each([
    ['S1', S1],
    ['S2', S2],
    ['S3', S3],
  ] as const)('%s', (_name, views) => {
    const map = displayMapOf(views);
    expect([...map.keys()]).toEqual(views.map((entry) => entry.canon));
    for (const entry of views) expect(map.get(entry.canon)).toBe(displayOf(entry, views));
    expect([...map.values()]).toEqual(displaysOf(views));
  });
});
