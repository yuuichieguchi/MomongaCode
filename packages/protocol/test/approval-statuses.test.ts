import { describe, expect, expectTypeOf, it } from 'vitest';
import { APPROVAL_STATUSES } from '@momonga/protocol';

describe('APPROVAL_STATUSES', () => {
  it('lists every approval status', () => {
    expect(APPROVAL_STATUSES).toEqual(['pending', 'resolved', 'superseded', 'expired', 'withdrawn']);
    expectTypeOf<(typeof APPROVAL_STATUSES)[number]>().toEqualTypeOf<'pending' | 'resolved' | 'superseded' | 'expired' | 'withdrawn'>();
  });
});
