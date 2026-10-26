import { describe, expect, it } from 'vitest';
import { budgetFor } from '../src/budget.ts';
import { MARGIN_RATIO, MIN_MARGIN, marginFloorFor, outputReserveFor } from '@momonga/protocol';
import { capabilitiesFor } from './helpers.ts';

describe('protocol margin constants match today\'s budgetFor', () => {
  it.for([1024, 2048, 4096, 32768, 200000])('a %i-token window has the margin floor of budgetFor', (window) => {
    expect(budgetFor(capabilitiesFor(window), 0).margin).toBe(marginFloorFor(window));
    expect(marginFloorFor(window)).toBe(Math.max(Math.ceil(MARGIN_RATIO * window), MIN_MARGIN));
  });

  it.for([0, 7, 300])('the error bound %i is added on top of the floor', (errorBound) => {
    expect(budgetFor(capabilitiesFor(4096), errorBound).margin).toBe(marginFloorFor(4096) + errorBound);
  });
});

describe('protocol outputReserveFor matches today\'s budgetFor R', () => {
  it.for(
    [1024, 2048, 4096, 32768, 200000].flatMap((window) => [64, 512, 1024, 4096, 100000].map((maxOutput) => [window, maxOutput] as const)),
  )('a %i-token window with maxOutputTokens %i reserves the R of budgetFor', ([window, maxOutput]) => {
    const capabilities = capabilitiesFor(window, { maxOutputTokens: maxOutput });
    expect(outputReserveFor(capabilities)).toBe(budgetFor(capabilities, 0).R);
  });
});
