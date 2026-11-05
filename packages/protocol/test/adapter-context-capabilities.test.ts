import { describe, expectTypeOf, it } from 'vitest';
import type { AdapterContext, Capabilities } from '@momonga/protocol';

describe('AdapterContext', () => {
  it('carries the capabilities the router resolved for the target', () => {
    expectTypeOf<AdapterContext>().toHaveProperty('capabilities');
    expectTypeOf<AdapterContext['capabilities']>().toEqualTypeOf<Capabilities>();
  });
});
