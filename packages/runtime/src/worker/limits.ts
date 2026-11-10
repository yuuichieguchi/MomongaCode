import { LOOP_GROUPS_KEPT, MAX_COST_USD, nanoOfAmount } from '@momonga/protocol';
import type { WorkerDefaults } from './types.ts';

export type RunLimits = {
  maxSteps: number;
  maxTotalTokens: number;
  approvalTtlMs: number;
  loopThreshold: number;
  maxCostNano?: number;
};

const DEFAULT_MAX_STEPS = 50;
const DEFAULT_MAX_TOTAL_TOKENS = 1_000_000;
const DEFAULT_APPROVAL_TTL_MS = 30 * 60 * 1000;
const DEFAULT_LOOP_THRESHOLD = 3;

const readLimit = (limits: Record<string, unknown>, key: string, fallback: number, minimum: number, maximum = Number.POSITIVE_INFINITY): number => {
  const value = limits[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new RangeError(`run limit ${key} must be a number of at least ${minimum}, received ${String(value)}`);
  }
  if (value > maximum) throw new RangeError(`run limit ${key} must be a number of at most ${maximum}, received ${String(value)}`);
  return value;
};

export const readRunLimits = (limits: Record<string, unknown>, defaults: WorkerDefaults = {}): RunLimits => ({
  maxSteps: readLimit(limits, 'maxSteps', defaults.maxSteps ?? DEFAULT_MAX_STEPS, 1),
  maxTotalTokens: readLimit(limits, 'maxTotalTokens', defaults.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS, 1),
  approvalTtlMs: readLimit(limits, 'approvalTtlMs', defaults.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS, 1),
  loopThreshold: readLimit(limits, 'loopThreshold', defaults.loopThreshold ?? DEFAULT_LOOP_THRESHOLD, 2, LOOP_GROUPS_KEPT),
  ...(limits['maxCostUsd'] === undefined ? {} : { maxCostNano: nanoOfAmount(readLimit(limits, 'maxCostUsd', 0, 0, MAX_COST_USD)) }),
});
