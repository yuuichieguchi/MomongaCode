import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearUntrustedSchemaCaches } from '@momonga/foundation';
import { validateToolInput } from '@momonga/tools';
import { makeTool } from './harness.ts';

const nativeSourcesRun: string[] = [];
const originalExec = RegExp.prototype.exec;
const originalTest = RegExp.prototype.test;

const schemaWithPattern = (pattern: string) => ({
  type: 'object',
  properties: { value: { type: 'string', pattern } },
  required: ['value'],
  additionalProperties: false,
});

const nativeRunsOfSchemaPattern = (pattern: string, value: string): string[] => {
  const tool = makeTool(`pattern_matcher_${nativeSourcesRun.length}_${pattern.length}`, { inputSchema: schemaWithPattern(pattern) });
  expect(validateToolInput(tool, { value }).ok).toBe(false);
  const compiledSource = new RegExp(pattern, 'u').source;
  return nativeSourcesRun.filter((source) => source === compiledSource || source === pattern);
};

beforeEach(() => {
  nativeSourcesRun.length = 0;
  clearUntrustedSchemaCaches();
  vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, input: string) {
    nativeSourcesRun.push(this.source);
    return originalExec.call(this, input);
  });
  vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (this: RegExp, input: string) {
    nativeSourcesRun.push(this.source);
    return originalTest.call(this, input);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an untrusted schema pattern on the calling thread', () => {
  it('is matched without the native backtracking RegExp for a nested quantifier the linear engine represents', () => {
    expect(nativeRunsOfSchemaPattern('^(a+)+$', 'aaaab')).toEqual([]);
  });

  it('is matched without the native backtracking RegExp for a nested quantifier around a property escape', () => {
    expect(nativeRunsOfSchemaPattern('^(\\p{L}+)+$', 'aaaa1')).toEqual([]);
  });

  it('is matched without the native backtracking RegExp for a backreference', () => {
    expect(nativeRunsOfSchemaPattern('^(a+)+\\1$', 'aaaab')).toEqual([]);
  });

  it('is matched without the native backtracking RegExp for a lookaround', () => {
    expect(nativeRunsOfSchemaPattern('^(?=(a+)+$)a*$', 'aaaab')).toEqual([]);
  });
});
