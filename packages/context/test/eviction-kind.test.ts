import { describe, expectTypeOf, it } from 'vitest';
import type { EvictionKind } from '@momonga/context';

describe('EvictionKind', () => {
  it('names a reference beside an omitted and a truncated output', () => {
    expectTypeOf<EvictionKind>().toEqualTypeOf<'omitted' | 'truncated' | 'reference'>();
  });
});
