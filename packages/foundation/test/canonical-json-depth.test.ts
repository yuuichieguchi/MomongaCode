import { describe, expect, it } from 'vitest';
import { JsonDepthError, MAX_JSON_DEPTH, canonicalJson } from '@momonga/foundation';

const STACK_BREAKING_DEPTH = 3000;

const nested = (depth: number): unknown => {
  let value: unknown = 1;
  for (let level = 0; level < depth; level += 1) value = { a: value };
  return value;
};

const nestedText = (depth: number): string => `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;

const thrownBy = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
};

describe('canonicalJson enforces the one JSON depth bound', () => {
  it('bounds JSON depth at 128', () => {
    expect(MAX_JSON_DEPTH).toBe(128);
  });

  it('encodes a value exactly at the bound', () => {
    expect(canonicalJson(nested(MAX_JSON_DEPTH))).toBe(nestedText(MAX_JSON_DEPTH));
  });

  it('counts an array as one level, like an object', () => {
    expect(canonicalJson([nested(MAX_JSON_DEPTH - 1)])).toBe(`[${nestedText(MAX_JSON_DEPTH - 1)}]`);
    expect(thrownBy(() => canonicalJson([nested(MAX_JSON_DEPTH)]))).toBeInstanceOf(JsonDepthError);
  });

  it.each([MAX_JSON_DEPTH + 1, STACK_BREAKING_DEPTH])('throws the typed depth error at depth %i, naming the bound', (depth) => {
    const error = thrownBy(() => canonicalJson(nested(depth)));
    expect(error).not.toBeInstanceOf(RangeError);
    expect(error).toBeInstanceOf(JsonDepthError);
    expect((error as Error).message).toMatch(/depth/i);
    expect((error as Error).message).toContain(String(MAX_JSON_DEPTH));
  });
});
