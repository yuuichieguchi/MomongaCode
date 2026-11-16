import { describe, expect, expectTypeOf, it } from 'vitest';
import { createPinnedDerivation } from '@momonga/config';
import type { PinnedDerivation } from '@momonga/config';

type Inputs = { plan: string; limit: number };

describe('pinned derivation inputs are typed by the caller', () => {
  it('hands derive the input type the caller names, with no cast', () => {
    const derivation: PinnedDerivation<number> = createPinnedDerivation<number, Inputs>({
      cache: { loadOrKeep: () => Promise.reject(new Error('not used by this test')) } as never,
      signal: new AbortController().signal,
      inputsOf: () => ({ plan: 'p', limit: 1 }),
      derive: (_settings, _previous, _signal, inputs) => {
        expectTypeOf(inputs).toEqualTypeOf<Inputs>();
        return inputs.limit;
      },
      retire: () => undefined,
      onWarning: () => undefined,
    });
    expect(derivation).toBeDefined();
  });
});
