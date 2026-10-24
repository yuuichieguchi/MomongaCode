import { describe, expect, it } from 'vitest';
import { registerCleanup } from '@momonga/testkit';

describe('registerCleanup inside a test', () => {
  const drained: string[] = [];

  it('keeps the cleanup pending while the test runs', (context) => {
    registerCleanup(context, () => void drained.push('ran'));
    expect(drained).toEqual([]);
  });

  it('drains the cleanup exactly once after its test', () => {
    expect(drained).toEqual(['ran']);
  });
});
