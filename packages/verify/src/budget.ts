import type { Clock } from '@momonga/foundation';

export type SolveBudget = { readonly totalMs: number; remainingMs(): number; share(propertiesLeft: number): SolveBudget };

const budgetUntil = (clock: Clock, totalMs: number, deadline: number): SolveBudget => ({
  totalMs,
  remainingMs: () => deadline - clock.now(),
  share: (propertiesLeft) => budgetUntil(clock, totalMs, clock.now() + (deadline - clock.now()) / propertiesLeft),
});

export const startBudget = (clock: Clock, totalMs: number): SolveBudget => budgetUntil(clock, totalMs, clock.now() + totalMs);
