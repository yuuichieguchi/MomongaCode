import { describe, expect, it } from 'vitest';
import { E2E_FILE_STACK, e2eFileWorkers } from '../e2e/support/parallelism.ts';

const GIB = 1024 ** 3;

describe('the number of e2e files that run at the same time', () => {
  it('is the number of stacks the processors carry when memory is not the narrower bound', () => {
    expect(e2eFileWorkers({ processors: 10, memoryBytes: 1024 * GIB })).toBe(Math.floor((10 - E2E_FILE_STACK.runProcessors) / E2E_FILE_STACK.processors));
  });

  it('is the number of stacks the memory share holds when memory is the narrower bound', () => {
    const memoryBytes = 3 * E2E_FILE_STACK.peakBytes / E2E_FILE_STACK.memoryShare;
    expect(e2eFileWorkers({ processors: 1024, memoryBytes })).toBe(3);
  });

  it('is one on a machine that carries less than one stack', () => {
    expect(e2eFileWorkers({ processors: 1, memoryBytes: GIB / 4 })).toBe(1);
  });
});
