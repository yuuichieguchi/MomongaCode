import { describe, expect, it } from 'vitest';
import { PACKAGING_FILE_STACK, packagingFileWorkers } from '../scripts/support/parallelism.ts';

const GIB = 1024 * 1024 * 1024;

describe('the packaging files that run at once', () => {
  it.each([
    ['this host, 10 processors and 32 GiB', 10, 32, 4],
    ['8 processors and 16 GiB', 8, 16, 3],
    ['1 processor and 8 GiB', 1, 8, 1],
    ['32 processors and 4 GiB: the memory share caps the workers at 2', 32, 4, 2],
  ])('plans %s as the formula says', (_label, processors, gibibytes, workers) => {
    expect(packagingFileWorkers({ processors, memoryBytes: gibibytes * GIB })).toBe(workers);
  });

  it('respects the memory share of the stack', () => {
    expect(packagingFileWorkers({ processors: 32, memoryBytes: 16 * GIB }, { ...PACKAGING_FILE_STACK, memoryShare: 0.25 })).toBe(4);
  });
});
