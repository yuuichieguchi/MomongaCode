import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@momonga/foundation';

const NESTING_DEPTH = 3000;

const nested = (depth: number): unknown => {
  let value: unknown = 1;
  for (let level = 0; level < depth; level += 1) value = { a: value };
  return value;
};

const outcomeOf = (run: () => string): { kind: 'encoded'; text: string } | { kind: 'thrown'; error: unknown } => {
  try {
    return { kind: 'encoded', text: run() };
  } catch (error) {
    return { kind: 'thrown', error };
  }
};

describe('canonicalJson on deeply nested values', () => {
  it(`never overflows the stack on a value nested ${NESTING_DEPTH} deep: it encodes it or names the nesting`, () => {
    const outcome = outcomeOf(() => canonicalJson(nested(NESTING_DEPTH)));
    if (outcome.kind === 'encoded') {
      expect(outcome.text).toBe(`${'{"a":'.repeat(NESTING_DEPTH)}1${'}'.repeat(NESTING_DEPTH)}`);
      return;
    }
    expect(outcome.error).not.toBeInstanceOf(RangeError);
    expect(outcome.error).toBeInstanceOf(TypeError);
    expect((outcome.error as Error).message).toMatch(/^canonicalJson: .*(nest|depth)/i);
  });
});
