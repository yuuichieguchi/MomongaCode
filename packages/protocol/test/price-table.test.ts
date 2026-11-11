import { describe, expect, it } from 'vitest';
import * as protocol from '@momonga/protocol';

type Problem = { index: number; field?: string; reason: string };

const exported = <T>(name: string): T => {
  const value = (protocol as Record<string, unknown>)[name];
  if (value === undefined) throw new Error(`@momonga/protocol does not export ${name}`);
  return value as T;
};

const problemOf = (entries: unknown): Problem | undefined => exported<(entries: unknown) => Problem | undefined>('priceTableProblem')(entries);

const ROW = { provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 3, outputPerMTok: 15, currency: 'USD' };

describe('the one check of a price table', () => {
  it('accepts rows that differ in provider, model or date, and prices of at most nine decimal places', () => {
    expect(problemOf([])).toBeUndefined();
    expect(problemOf([ROW, { ...ROW, effectiveFrom: '2026-02-28' }, { ...ROW, model: 'm2', inputPerMTok: 0.000000001, cachedInputPerMTok: 0 }])).toBeUndefined();
  });

  it('names the row and the field of the first problem', () => {
    expect(problemOf([ROW, { ...ROW, effectiveFrom: '2026-13-01' }])).toMatchObject({ index: 1, field: 'effectiveFrom' });
    expect(problemOf([{ ...ROW, effectiveFrom: '2026-02-30' }])).toMatchObject({ index: 0, field: 'effectiveFrom' });
    expect(problemOf([{ ...ROW, effectiveFrom: '2026-1-1' }])).toMatchObject({ index: 0, field: 'effectiveFrom' });
    expect(problemOf([ROW, ROW])).toMatchObject({ index: 1 });
    expect(problemOf([ROW, ROW])?.field).toBeUndefined();
    expect(problemOf([{ ...ROW, outputPerMTok: -1 }])).toMatchObject({ index: 0, field: 'outputPerMTok' });
    expect(problemOf([{ ...ROW, cachedInputPerMTok: 0.0000000001 }])).toMatchObject({ index: 0, field: 'cachedInputPerMTok' });
    expect(problemOf([{ ...ROW, cacheWritePerMTok: Number.NaN }])).toMatchObject({ index: 0, field: 'cacheWritePerMTok' });
    expect(problemOf([{ ...ROW, currency: 'EUR' }])).toMatchObject({ index: 0, field: 'currency' });
  });

  it('validatePriceTable throws the same problem, naming the row', () => {
    const validate = exported<(entries: unknown) => void>('validatePriceTable');
    expect(() => validate([ROW])).not.toThrow();
    expect(() => validate([ROW, ROW])).toThrow(/acme\/m1@2026-01-01/);
    expect(() => validate([{ ...ROW, inputPerMTok: 0.0000000001 }])).toThrow(/inputPerMTok.*9 decimal places/);
  });
});

describe('the smallest output-token bound a request may carry', () => {
  it('is the minimum the Open Responses request schema states', () => {
    expect(exported<number>('MIN_REQUEST_OUTPUT_TOKENS')).toBe(16);
  });
});
