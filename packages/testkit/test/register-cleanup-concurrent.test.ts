import { describe, expect, it } from 'vitest';
import { registerCleanup } from '@momonga/testkit';

const cleanupLog: string[] = [];
const aRegistered = Promise.withResolvers<void>();
const bRegistered = Promise.withResolvers<void>();
const aDrained = Promise.withResolvers<void>();
const aBodyDone = Promise.withResolvers<void>();

describe('registerCleanup under it.concurrent', () => {
  describe('two overlapping tests', () => {
    it.concurrent('test A drains only its own cleanups when it finishes first', async (context) => {
      registerCleanup(context, () => aDrained.resolve());
      registerCleanup(context, () => void cleanupLog.push('A1'));
      registerCleanup(context, () => void cleanupLog.push('A2'));
      aRegistered.resolve();
      await bRegistered.promise;
      expect(cleanupLog).toEqual([]);
      aBodyDone.resolve();
    });

    it.concurrent('test B keeps its cleanups pending until it finishes itself', async (context) => {
      registerCleanup(context, () => void cleanupLog.push('B1'));
      registerCleanup(context, () => void cleanupLog.push('B2'));
      bRegistered.resolve();
      await aRegistered.promise;
      await aBodyDone.promise;
      await aDrained.promise;
      expect(cleanupLog).toEqual(['A2', 'A1']);
    });
  });

  it('every cleanup ran exactly once, in reverse registration order within each test', () => {
    expect(cleanupLog).toEqual(['A2', 'A1', 'B2', 'B1']);
  });
});
