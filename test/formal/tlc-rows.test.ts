import { describe, expect, it } from 'vitest';
import { EVERY_RUN_TLC_ROW_STACK, EVERY_RUN_TLC_WORKERS, TLC_ROW_STACK, everyRunTlcRowsAtOnce, tlcRowsAtOnce, tlcWorkersForTier, tlcWorkersOf } from './tlc-rows.ts';

const GIB = 1024 * 1024 * 1024;

describe('the TLC rows that run at once', () => {
  it.each([
    ['this host, 10 processors and 32 GiB', 10, 32, 2],
    ['9 processors: the odd processor cannot hold a second row', 9, 32, 1],
    ['1 processor', 1, 32, 1],
    ['64 processors and 256 GiB: the memory share caps the rows', 64, 256, 2],
  ])('runs %s as the formula says', (_label, processors, gibibytes, rows) => {
    expect(tlcRowsAtOnce({ processors, memoryBytes: gibibytes * GIB })).toBe(rows);
  });

  it('gives each row half the processors, rounded up, as the workers of the row', () => {
    expect([1, 2, 9, 10].map(tlcWorkersOf)).toEqual([1, 1, 5, 5]);
  });

  it('gives every-run rows one worker and deep rows half the processors', () => {
    expect(tlcWorkersForTier('every-run', 10)).toBe(EVERY_RUN_TLC_WORKERS);
    expect(tlcWorkersForTier('deep', 10)).toBe(5);
  });

  it('never plans more rows than the processors hold at one row of workers each, and never fewer than one', () => {
    for (let processors = 1; processors <= 64; processors += 1) {
      const rows = tlcRowsAtOnce({ processors, memoryBytes: 32 * GIB });
      expect(rows, `${processors} processors`).toBeGreaterThanOrEqual(1);
      expect(rows * tlcWorkersOf(processors), `${processors} processors`).toBeLessThanOrEqual(processors);
    }
  });

  it('counts the heap ceiling of each row against the share of memory the rows may take', () => {
    expect(tlcRowsAtOnce({ processors: 64, memoryBytes: 32 * GIB }, { ...TLC_ROW_STACK, memoryShare: 0.25 })).toBe(1);
  });

  it.each([
    ['this host, 10 processors and 32 GiB', 10, 32, 9],
    ['8 processors and 16 GiB', 8, 16, 7],
    ['1 processor and 8 GiB', 1, 8, 1],
    ['32 processors and 8 GiB: the memory share caps the rows at 4', 32, 8, 4],
  ])('runs every-run rows on %s as the formula says', (_label, processors, gibibytes, rows) => {
    expect(everyRunTlcRowsAtOnce({ processors, memoryBytes: gibibytes * GIB })).toBe(rows);
  });

  it('caps every-run rows by both remaining processors and memory share', () => {
    expect(everyRunTlcRowsAtOnce({ processors: 10, memoryBytes: 4 * GIB }, EVERY_RUN_TLC_ROW_STACK)).toBe(2);
  });
});
