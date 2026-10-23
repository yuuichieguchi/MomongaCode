import type { Capabilities } from '@momonga/protocol';
import type { ContextBudget } from './types.ts';

const MIN_OUTPUT_RESERVE = 256;
const OUTPUT_RESERVE_RATIO = 0.25;
const MAX_OUTPUT_WINDOW_RATIO = 0.5;
const MARGIN_RATIO = 0.02;
const ITEM_CAP_RATIO = 0.25;
const MIN_ITEM_CAP = 64;
const MIN_MARGIN = 32;

export const budgetFor = (capabilities: Capabilities, errorBound: number): ContextBudget => {
  const W = capabilities.contextWindow;
  const R = Math.min(
    capabilities.maxOutputTokens,
    Math.max(MIN_OUTPUT_RESERVE, Math.ceil(OUTPUT_RESERVE_RATIO * W)),
    Math.floor(MAX_OUTPUT_WINDOW_RATIO * W),
  );
  const margin = Math.max(Math.ceil(MARGIN_RATIO * W), MIN_MARGIN) + errorBound;
  return { W, R, margin, I: Math.max(0, W - R - margin) };
};

export const itemCapFor = (capabilities: Capabilities): number =>
  Math.max(MIN_ITEM_CAP, Math.floor(ITEM_CAP_RATIO * budgetFor(capabilities, 0).I));
