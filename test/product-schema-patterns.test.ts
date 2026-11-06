import { describe, expect, it } from 'vitest';
import { evaluateWithPatternAnswers } from '@momonga/ata-validator/lite';
import { validateUntrusted } from '@momonga/foundation';
import { loadProductSchemas } from './support/product-schemas.ts';
import { NO_WALL_CLOCK_TIMEOUT_FOR_SYNCHRONOUS_WORK } from './support/synchronous-work.ts';

const schemas = await loadProductSchemas();

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const patternsIn = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(patternsIn);
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(key === 'pattern' && typeof child === 'string' ? [child] : []),
    ...(key === 'patternProperties' && isRecord(child) ? Object.keys(child) : []),
    ...patternsIn(child),
  ]);
};

const needsWorker = (pattern: string): boolean =>
  evaluateWithPatternAnswers(new Map(), () => validateUntrusted('product-schema-pattern-probe', { type: 'string', pattern }, '')).queries.length > 0;

describe('the product schemas, validated on the calling thread', () => {
  it('hold no pattern that only the off-thread check can match', NO_WALL_CLOCK_TIMEOUT_FOR_SYNCHRONOUS_WORK, () => {
    const patterns = [...new Set(schemas.flatMap((entry) => [...patternsIn(entry.schema), ...[...entry.remotes.values()].flatMap(patternsIn)]))];
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.filter(needsWorker)).toEqual([]);
  });

  it('would see a backreference as one', NO_WALL_CLOCK_TIMEOUT_FOR_SYNCHRONOUS_WORK, () => {
    expect(needsWorker('^(a)\\1$')).toBe(true);
  });
});
