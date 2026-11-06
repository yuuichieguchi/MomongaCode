import { describe, expect, it } from 'vitest';
import { clearUntrustedSchemaCaches, validateUntrusted } from '@momonga/foundation';

const UNIQUE_ARRAY = { type: 'array', uniqueItems: true } as const;
const HASH_MULTIPLIER = 0x9e3779b1;
const COUNT = 4096;
const READS_PER_ITEM_PER_LEVEL = 8;
const VERDICT_COUNT = 64;
const QUADRATIC_TODAY_TIMEOUT_MS = 300_000;

const doubleOfWords = (high: number, low: number): number => {
  const words = new Uint32Array([low >>> 0, high >>> 0]);
  return new Float64Array(words.buffer)[0]!;
};

const collidingDoubles = (count: number): number[] =>
  Array.from({ length: count }, (_, index) => {
    const high = 0x3ff00000 + index + 1;
    return doubleOfWords(high, Math.imul(high, HASH_MULTIPLIER));
  });

const elementReadsOf = (items: unknown[]): { reads: number; target: unknown[] } => {
  const counter = { reads: 0 };
  const target = new Proxy(items, {
    get(array, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) counter.reads += 1;
      return Reflect.get(array, key, receiver);
    },
  });
  return { get reads() { return counter.reads; }, target };
};

const readBound = (count: number): number => READS_PER_ITEM_PER_LEVEL * count * Math.ceil(Math.log2(count));

const validateCounted = (items: unknown[]): { valid: boolean; reads: number } => {
  clearUntrustedSchemaCaches();
  const counted = elementReadsOf(items);
  const verdict = validateUntrusted('unique-items-cost', UNIQUE_ARRAY, counted.target);
  return { valid: verdict.valid, reads: counted.reads };
};

describe('the colliding doubles themselves', () => {
  it('are distinct, finite, not integers, and share one bucket of the fixed hash', () => {
    const doubles = collidingDoubles(COUNT);
    expect(new Set(doubles).size).toBe(COUNT);
    for (const value of doubles) {
      expect(Number.isFinite(value)).toBe(true);
      expect(Number.isInteger(value)).toBe(false);
      const words = new Uint32Array(new Float64Array([value]).buffer);
      expect((words[0]! ^ Math.imul(words[1]!, HASH_MULTIPLIER)) >>> 0).toBe(0);
    }
  });
});

describe('uniqueItems over colliding doubles beside one object', () => {
  it('accepts the distinct array with element reads bounded by n log n', () => {
    const { valid, reads } = validateCounted([...collidingDoubles(COUNT), {}]);
    expect(valid).toBe(true);
    expect(reads).toBeLessThanOrEqual(readBound(COUNT + 1));
  }, QUADRATIC_TODAY_TIMEOUT_MS);

  it('rejects the array whose last item repeats the first, with element reads bounded by n log n', () => {
    const doubles = collidingDoubles(COUNT);
    const { valid, reads } = validateCounted([...doubles, {}, doubles[0]]);
    expect(valid).toBe(false);
    expect(reads).toBeLessThanOrEqual(readBound(COUNT + 2));
  }, QUADRATIC_TODAY_TIMEOUT_MS);

  it('rejects the array whose two objects are equal under another key order', () => {
    const { valid } = validateCounted([...collidingDoubles(VERDICT_COUNT), { a: 1, b: [2] }, { b: [2], a: 1 }]);
    expect(valid).toBe(false);
  });

  it('accepts minus zero and zero as one value only when they are not both present', () => {
    expect(validateCounted([...collidingDoubles(VERDICT_COUNT), {}, 0]).valid).toBe(true);
    expect(validateCounted([...collidingDoubles(VERDICT_COUNT), {}, 0, -0]).valid).toBe(false);
  });
});
