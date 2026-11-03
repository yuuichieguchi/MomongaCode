import { describe, expect, it } from 'vitest';
import { memoryBudgetFor } from '@momonga/context';

describe('memoryBudgetFor with a share', () => {
  it('applies the share to the room and floors the result', () => {
    expect(memoryBudgetFor(1000, 1 / 8)).toBe(125);
    expect(memoryBudgetFor(1000, 1 / 16)).toBe(62);
    expect(memoryBudgetFor(1000, 1 / 2)).toBe(500);
    expect(memoryBudgetFor(1000)).toBe(250);
  });
});
