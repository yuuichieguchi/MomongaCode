import { ITEM_CAP, ITEM_ROOM, MIN_SUMMARY_TOKENS, ceilRatio, floorRatio, marginFloorFor, outputReserveFor, sizingFractionFor, summaryItemTokensFor } from '@momonga/protocol';
import type { Ratio } from '@momonga/protocol';
import type { Capabilities } from '@momonga/protocol';
import type { ContextBudget } from './types.ts';
import { WORKING_STATE_MESSAGE_MIN_TOKENS } from './working-state.ts';

const DEFAULT_MEMORY_ROOM_SHARE = ITEM_ROOM.num / (ITEM_ROOM.den * 2);
export const MIN_ITEM_CAP = 64;

export const MIN_ROOM_TOKENS = MIN_ITEM_CAP + summaryItemTokensFor(MIN_SUMMARY_TOKENS) + WORKING_STATE_MESSAGE_MIN_TOKENS;

export const budgetFor = (capabilities: Capabilities, errorBound: number): ContextBudget => {
  const W = capabilities.contextWindow;
  const R = outputReserveFor(capabilities);
  const margin = marginFloorFor(W) + errorBound;
  return { W, R, margin, I: Math.max(0, W - R - margin) };
};

const discountedFloor = (sizing: Ratio, x: number): number => floorRatio({ num: sizing.den, den: sizing.den + sizing.num }, x);

export const inputCeilingFor = (capabilities: Capabilities): number => {
  const { W, R } = budgetFor(capabilities, 0);
  return Math.max(0, discountedFloor(sizingFractionFor(capabilities), W - R - marginFloorFor(W)));
};

export const summaryInputCeilingFor = (capabilities: Capabilities): number => {
  const { W, R } = budgetFor(capabilities, 0);
  return Math.max(0, Math.min(discountedFloor(sizingFractionFor(capabilities), W - marginFloorFor(W)), W - R));
};

export const itemCapFor = (capabilities: Capabilities, room?: number): number => {
  const base = Math.max(MIN_ITEM_CAP, floorRatio(ITEM_CAP, budgetFor(capabilities, 0).I));
  return room === undefined ? base : Math.max(MIN_ITEM_CAP, Math.min(base, floorRatio(ITEM_ROOM, room)));
};

export const memoryBudgetFor = (room: number, share: number = DEFAULT_MEMORY_ROOM_SHARE): number => Math.floor(share * room);

export const pinnedFloorFor = (capabilities: Capabilities): number => {
  const ceiling = inputCeilingFor(capabilities);
  return ceiling - Math.max(MIN_ROOM_TOKENS, ceilRatio(ITEM_CAP, ceiling));
};
