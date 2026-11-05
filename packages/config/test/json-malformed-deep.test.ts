import { describe, expect, it } from 'vitest';
import { MAX_JSON_DEPTH } from '@momonga/foundation';
import { parseJsonText } from '../src/json-file.ts';

const STACK_BREAKING_DEPTH = 3000;

const malformedAt = (depth: number): string => `${'['.repeat(depth)}1,`;

const failureOf = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a failure');
};

describe('malformed settings text nested past the bound', () => {
  it.each([MAX_JSON_DEPTH + 1, STACK_BREAKING_DEPTH])('fails with the loader error naming the file and the depth at depth %i', (depth) => {
    const failure = failureOf(() => parseJsonText(malformedAt(depth), 'settings.json'));
    expect(failure).not.toBeInstanceOf(RangeError);
    expect(failure.message).toContain('settings.json');
    expect(failure.message).toMatch(/depth/i);
    expect(failure.message).toContain(String(MAX_JSON_DEPTH));
  });

  it('still reports the position of a syntax error within the bound', () => {
    const failure = failureOf(() => parseJsonText(malformedAt(MAX_JSON_DEPTH), 'settings.json'));
    expect(failure.message).toMatch(/settings\.json: invalid JSON at line 1 column/);
  });
});
