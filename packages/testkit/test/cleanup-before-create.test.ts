import fs from 'node:fs';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';

const MISSING_CONTEXT = /test context/i;

const redirectTempRoot = (context: CleanupContext): string => {
  const root = withTempDir(context);
  const previous = process.env['TMPDIR'];
  registerCleanup(context, () => {
    if (previous === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = previous;
  });
  process.env['TMPDIR'] = root;
  expect(fs.realpathSync(os.tmpdir())).toBe(root);
  return root;
};

describe('withTempDir without a usable test context', () => {
  it.for([
    ['an undefined context', undefined],
    ['a context without onTestFinished', {}],
  ] as const)('throws before creating any directory for %s', ([, missing], context) => {
    const root = redirectTempRoot(context);
    expect(() => withTempDir(missing as never)).toThrow(MISSING_CONTEXT);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('names the missing test context in the error message', (context) => {
    redirectTempRoot(context);
    let message = '';
    try {
      withTempDir(undefined);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(MISSING_CONTEXT);
    expect(message).toMatch(/onTestFinished/);
  });
});

describe('registerCleanup without a usable test context', () => {
  it.for([
    ['an undefined context', undefined],
    ['a context without onTestFinished', {}],
  ] as const)('throws an error naming the missing test context for %s', ([, missing]) => {
    expect(() => registerCleanup(missing as never, () => undefined)).toThrow(MISSING_CONTEXT);
  });
});
