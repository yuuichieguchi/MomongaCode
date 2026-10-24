import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerCleanup } from '@momonga/testkit';

describe('registerCleanup accepted contexts', () => {
  const beforeEachDrains: string[] = [];
  const afterEachDrains: string[] = [];

  describe('beforeEach hook', () => {
    beforeEach((context) => {
      registerCleanup(context, () => void beforeEachDrains.push('drained'));
    });
    it('keeps the beforeEach cleanup pending while the test runs', () => {
      expect(beforeEachDrains).toEqual([]);
    });
  });

  describe('afterEach hook', () => {
    afterEach((context) => {
      registerCleanup(context, () => void afterEachDrains.push('drained'));
    });
    it('runs before the afterEach registration', () => {
      expect(afterEachDrains).toEqual([]);
    });
  });

  it('drains the beforeEach cleanup exactly once after its test', () => {
    expect(beforeEachDrains).toEqual(['drained']);
  });

  it('drains the afterEach cleanup exactly once after its test', () => {
    expect(afterEachDrains).toEqual(['drained']);
  });
});
