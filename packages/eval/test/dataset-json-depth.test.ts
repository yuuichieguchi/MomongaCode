import { describe, expect, it } from 'vitest';
import { DatasetError, parseDataset } from '@momonga/eval';
import { MAX_JSON_DEPTH } from '@momonga/foundation';

const nestedArraysText = (depth: number): string => `${'['.repeat(depth)}${']'.repeat(depth)}`;

const datasetText = (depth: number): string => `{"extra":${nestedArraysText(depth - 1)}}`;

const thrownBy = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a throw');
};

describe('eval datasets and the one JSON depth bound', () => {
  it(`refuses a dataset nested ${MAX_JSON_DEPTH + 1} deep, naming the source and the depth`, () => {
    const error = thrownBy(() => parseDataset(datasetText(MAX_JSON_DEPTH + 1), 'deep.json'));
    expect(error).toBeInstanceOf(DatasetError);
    expect(error.message).toContain('deep.json');
    expect(error.message).toMatch(/depth/i);
    expect(error.message).toContain(String(MAX_JSON_DEPTH));
  });

  it(`passes a dataset nested exactly ${MAX_JSON_DEPTH} deep on to schema validation`, () => {
    const error = thrownBy(() => parseDataset(datasetText(MAX_JSON_DEPTH), 'deep.json'));
    expect(error).toBeInstanceOf(DatasetError);
    expect(error.message).toMatch(/invalid dataset/);
    expect(error.message).not.toMatch(/depth/i);
  });
});
