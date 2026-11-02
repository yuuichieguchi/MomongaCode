import { MIN_SUMMARY_TOKENS, marginFloorFor, outputReserveFor, sizingRatioFor } from '@momonga/protocol';
import type { Capabilities } from '@momonga/protocol';
import type { ContextBudget } from './types.ts';

const ITEM_CAP_RATIO = 0.25;
const ITEM_ROOM_RATIO = 0.5;
const MEMORY_ROOM_RATIO = ITEM_ROOM_RATIO / 2;
const MIN_ITEM_CAP = 64;
const ROOM_SLACK_TOKENS = 64;

export const MIN_ROOM_TOKENS = MIN_ITEM_CAP + MIN_SUMMARY_TOKENS + ROOM_SLACK_TOKENS;

export const budgetFor = (capabilities: Capabilities, errorBound: number): ContextBudget => {
  const W = capabilities.contextWindow;
  const R = outputReserveFor(capabilities);
  const margin = marginFloorFor(W) + errorBound;
  return { W, R, margin, I: Math.max(0, W - R - margin) };
};

export const inputCeilingFor = (capabilities: Capabilities): number => {
  const { W, R } = budgetFor(capabilities, 0);
  return Math.max(0, Math.floor((W - R - marginFloorFor(W)) / (1 + sizingRatioFor(capabilities))));
};

export const summaryInputCeilingFor = (capabilities: Capabilities): number => {
  const { W, R } = budgetFor(capabilities, 0);
  return Math.max(0, Math.min(Math.floor((W - marginFloorFor(W)) / (1 + sizingRatioFor(capabilities))), W - R));
};

export const itemCapFor = (capabilities: Capabilities, room?: number): number => {
  const base = Math.max(MIN_ITEM_CAP, Math.floor(ITEM_CAP_RATIO * budgetFor(capabilities, 0).I));
  return room === undefined ? base : Math.max(MIN_ITEM_CAP, Math.min(base, Math.floor(ITEM_ROOM_RATIO * room)));
};

export const memoryBudgetFor = (room: number): number => Math.floor(MEMORY_ROOM_RATIO * room);
