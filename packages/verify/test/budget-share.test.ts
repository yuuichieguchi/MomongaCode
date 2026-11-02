import { describe, expect, it } from 'vitest';
import { startBudget } from '../src/budget.ts';

const steppedClock = () => {
  let current = 1000;
  return { clock: { now: () => current }, advance: (ms: number): void => void (current += ms) };
};

describe('a share of the verification budget', () => {
  it('is the remaining budget divided by the properties left', () => {
    const { clock } = steppedClock();
    const budget = startBudget(clock, 100);

    expect(budget.share(4).remainingMs()).toBe(25);
    expect(budget.share(1).remainingMs()).toBe(100);
  });

  it('lets a property that spends its whole share leave the rest to the others', () => {
    const { clock, advance } = steppedClock();
    const budget = startBudget(clock, 100);

    advance(budget.share(4).remainingMs());

    expect(budget.remainingMs()).toBe(75);
    expect(budget.share(3).remainingMs()).toBe(25);
  });

  it('carries unused time forward', () => {
    const { clock, advance } = steppedClock();
    const budget = startBudget(clock, 100);

    advance(5);

    expect(budget.share(3).remainingMs()).toBeCloseTo(95 / 3, 6);
  });

  it('is spent when the whole budget is spent, and keeps the total in its message', () => {
    const { clock, advance } = steppedClock();
    const budget = startBudget(clock, 100);
    advance(100);

    expect(budget.share(2).remainingMs()).toBeLessThanOrEqual(0);
    expect(budget.remainingMs()).toBe(0);
    expect(budget.share(2).totalMs).toBe(100);
  });
});
