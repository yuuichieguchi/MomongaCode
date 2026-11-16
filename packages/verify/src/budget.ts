import type { Timing } from '@momonga/foundation';

export type SolveBudget = { readonly totalMs: number; remainingMs(): number; share(propertiesLeft: number): SolveBudget };

export type BudgetTiming = Pick<Timing, 'monotonicMs'>;

const budgetUntil = (timing: BudgetTiming, totalMs: number, deadline: number): SolveBudget => ({
  totalMs,
  remainingMs: () => deadline - timing.monotonicMs(),
  share: (propertiesLeft) => budgetUntil(timing, totalMs, timing.monotonicMs() + (deadline - timing.monotonicMs()) / propertiesLeft),
});

export const startBudget = (timing: BudgetTiming, totalMs: number): SolveBudget => budgetUntil(timing, totalMs, timing.monotonicMs() + totalMs);
