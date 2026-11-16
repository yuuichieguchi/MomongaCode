import { describe, expect, it } from 'vitest';
import { startBudget } from '../src/budget.ts';

describe('the deadline of a verification budget', () => {
  it('is measured on the monotonic reading, so a wall clock that jumps back does not extend the budget', () => {
    let monotonic = 0;
    let wall = 1000;
    const clock = { now: () => wall, monotonicMs: () => monotonic };
    const budget = startBudget(clock, 100);

    monotonic += 60;
    wall -= 500;

    expect(budget.remainingMs()).toBe(40);
    expect(budget.share(2).remainingMs()).toBe(20);
  });
});
