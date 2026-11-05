import { describe, expect, it } from 'vitest';
import { JsonDepthError, MAX_JSON_DEPTH, canonicalJson } from '@momonga/foundation';

const UNBOUNDED_DEPTH = 100_000;

const nested = (depth: number): unknown => {
  let value: unknown = 1;
  for (let level = 0; level < depth; level += 1) value = { a: value };
  return value;
};

const nestedText = (depth: number): string => `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;

const outcomeOf = (run: () => string): { text: string } | { error: unknown } => {
  try {
    return { text: run() };
  } catch (error) {
    return { error };
  }
};

describe('canonicalJson has no depth limit of its own', () => {
  it(`encodes a value past the outside-data bound exactly`, () => {
    expect(canonicalJson(nested(MAX_JSON_DEPTH + 1))).toBe(nestedText(MAX_JSON_DEPTH + 1));
  });

  it('sorts keys at every level of a nested value', () => {
    expect(canonicalJson({ b: [{ d: 1, c: { f: 2, e: 3 } }], a: null })).toBe('{"a":null,"b":[{"c":{"e":3,"f":2},"d":1}]}');
  });

  it(`encodes a value ${UNBOUNDED_DEPTH} levels deep without a stack overflow or a depth error`, () => {
    const outcome = outcomeOf(() => canonicalJson([nested(UNBOUNDED_DEPTH)]));
    if ('error' in outcome) {
      expect(outcome.error).not.toBeInstanceOf(RangeError);
      expect(outcome.error).not.toBeInstanceOf(JsonDepthError);
    }
    expect(outcome).toHaveProperty('text');
    if ('text' in outcome) {
      expect(outcome.text.length).toBe(nestedText(UNBOUNDED_DEPTH).length + 2);
      expect(outcome.text.startsWith(`[${'{"a":'.repeat(8)}`)).toBe(true);
      expect(outcome.text.endsWith(`1${'}'.repeat(8)}]`)).toBe(true);
    }
  });

  it('still reports a cycle with its path', () => {
    const inner: Record<string, unknown> = {};
    const root = { a: { b: inner } };
    inner['c'] = root;
    expect(() => canonicalJson(root)).toThrow(TypeError);
    expect(() => canonicalJson(root)).toThrow('canonicalJson: cannot encode circular reference at a.b.c');
  });
});
