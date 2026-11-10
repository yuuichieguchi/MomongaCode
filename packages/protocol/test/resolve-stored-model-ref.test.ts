import { describe, expect, it } from 'vitest';
import { resolveStoredModelRef, resolveTypedModelRef, storedModelRef, typedModelText } from '../src/index.ts';
import { S1, view } from './model-ref-fixtures.ts';
import type { View } from './model-ref-fixtures.ts';

const stored = (text: string, views: readonly View[]): View | undefined => resolveStoredModelRef(storedModelRef(text), views);

describe('resolveStoredModelRef: a value the product stored', () => {
  it('a stored canonical reference of a configured model gives that model, the member of the views', () => {
    expect(stored('ollama/devstral-small-2:latest', S1)).toBe(S1[0]);
  });

  it('a stored text that is not a canonical reference gives nothing: no short form, no bare name', () => {
    expect(['ollama/devstral-small-2', 'devstral-small-2', 'devstral-small-2:latest'].map((text) => stored(text, S1))).toEqual([undefined, undefined, undefined]);
  });

  it('a stored reference never moves to a model whose own name equals the stored text', () => {
    const views = [view('p1', 'p1/x')];
    expect(stored('p1/x', views)).toBeUndefined();
    expect(resolveTypedModelRef(typedModelText('p1/x'), views)).toEqual({ kind: 'found', model: { canon: 'p1/p1/x', provider: 'p1', ownName: 'p1/x' } });
  });

  it('a value an earlier build stored gives nothing', () => {
    expect(stored('local', S1)).toBeUndefined();
  });
});
