import { describe, expect, it } from 'vitest';
import { budgetFor, inputCeilingFor, itemCapFor } from '@momonga/context';
import {
  ESTIMATED_ERROR_BOUND_RATIO,
  FENCE_BOUNDARY_LENGTH,
  MARGIN_RATIO,
  MAX_SUMMARY_TOKENS,
  MIN_MARGIN,
  MIN_SUMMARY_TOKENS,
  SUMMARY_ACCEPT_RATIO,
  SUMMARY_ITEM_OVERHEAD,
  SUMMARY_PROMPT_TOKENS,
  SUMMARY_ROOM_RATIO,
  SUMMARY_WINDOW_RATIO,
  marginFloorFor,
  outputReserveFor,
  summaryItemTokensFor,
  compactionSummaryMessage,
  summaryTokenCapFor,
  tokensForText,
} from '@momonga/protocol';
import { capabilitiesFor } from './helpers.ts';

describe('budget constants are pinned by literal values', () => {
  it('keeps the protocol ratios and floors', () => {
    expect(MARGIN_RATIO).toBe(0.02);
    expect(MIN_MARGIN).toBe(32);
    expect(ESTIMATED_ERROR_BOUND_RATIO).toBe(0.3);
    expect(MIN_SUMMARY_TOKENS).toBe(64);
    expect(MAX_SUMMARY_TOKENS).toBe(4096);
    expect(SUMMARY_WINDOW_RATIO).toBe(0.06);
    expect(SUMMARY_ROOM_RATIO).toBe(0.3);
    expect(SUMMARY_ACCEPT_RATIO).toBe(1.3);
    expect(SUMMARY_ITEM_OVERHEAD).toBe(tokensForText(String(compactionSummaryMessage('', 'model', 'b'.repeat(FENCE_BOUNDARY_LENGTH)).content)));
    expect(SUMMARY_PROMPT_TOKENS).toBe(484);
  });

  it.for([
    [113],
    [189],
    [246],
  ] as const)('summaryItemTokensFor(%i) is the accepted summary tokens plus the item overhead', ([cap]) => {
    expect(summaryItemTokensFor(cap)).toBe(Math.ceil(cap * SUMMARY_ACCEPT_RATIO) + SUMMARY_ITEM_OVERHEAD);
  });
});

describe('budget formulas at maxOutputTokens 1024 with estimated counting', () => {
  it.for([
    { window: 1024, R: 256, margin: 32, I: 736, ceiling: 566, itemCap: 184, summaryCap: 64 },
    { window: 2048, R: 512, margin: 41, I: 1495, ceiling: 1150, itemCap: 373, summaryCap: 123 },
    { window: 4096, R: 1024, margin: 82, I: 2990, ceiling: 2300, itemCap: 747, summaryCap: 246 },
    { window: 8192, R: 1024, margin: 164, I: 7004, ceiling: 5387, itemCap: 1751, summaryCap: 492 },
    { window: 32768, R: 1024, margin: 656, I: 31088, ceiling: 23913, itemCap: 7772, summaryCap: 1967 },
    { window: 200000, R: 1024, margin: 4000, I: 194976, ceiling: 149981, itemCap: 48744, summaryCap: 4096 },
  ])('a $window-token window has R $R, margin $margin, I $I and ceiling $ceiling', (row) => {
    const capabilities = capabilitiesFor(row.window, { maxOutputTokens: 1024, tokenCounting: 'estimated' });
    expect(budgetFor(capabilities, 0, 0)).toEqual({ W: row.window, R: row.R, margin: row.margin, I: row.I });
    expect(outputReserveFor(capabilities)).toBe(row.R);
    expect(marginFloorFor(row.window)).toBe(row.margin);
    expect(inputCeilingFor(capabilities)).toBe(row.ceiling);
    expect(itemCapFor(capabilities)).toBe(row.itemCap);
    expect(summaryTokenCapFor(capabilities)).toBe(row.summaryCap);
  });

  it.for([0, 7, 300])('adds the error bound %i on top of the margin floor', (errorBound) => {
    const capabilities = capabilitiesFor(4096, { maxOutputTokens: 1024, tokenCounting: 'estimated' });
    expect(budgetFor(capabilities, errorBound, 0)).toEqual({ W: 4096, R: 1024, margin: 82 + errorBound, I: 2990 - errorBound });
  });
});

describe('outputReserveFor by literal values', () => {
  it.for([
    [1024, 1024, 256],
    [4096, 64, 64],
    [4096, 4096, 1024],
    [1024, 100000, 256],
    [300, 4096, 150],
    [200000, 100000, 50000],
    [2048, 300, 300],
  ] as const)('a %i-token window with maxOutputTokens %i reserves %i', ([window, maxOutputTokens, reserve]) => {
    const capabilities = capabilitiesFor(window, { maxOutputTokens });
    expect(outputReserveFor(capabilities)).toBe(reserve);
    expect(budgetFor(capabilities, 0, 0).R).toBe(reserve);
  });
});
