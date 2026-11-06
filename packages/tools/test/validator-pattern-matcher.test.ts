import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearUntrustedSchemaCaches } from '@momonga/foundation';
import { validateToolInput } from '@momonga/tools';
import { makeTool } from './harness.ts';
import { recordedWorkers } from './worker-record.ts';

vi.mock('node:worker_threads', async (importOriginal) => (await import('./worker-record.ts')).recordingWorkerModule(importOriginal as never));
vi.mock('worker_threads', async (importOriginal) => (await import('./worker-record.ts')).recordingWorkerModule(importOriginal as never));

type NativeRun = { source: string; input: string };

const nativeRuns: NativeRun[] = [];
const originalExec = RegExp.prototype.exec;
const originalTest = RegExp.prototype.test;

const schemaWithPattern = (pattern: string) => ({
  type: 'object',
  properties: { value: { type: 'string', pattern } },
  required: ['value'],
  additionalProperties: false,
});

let toolCount = 0;

const checked = async (pattern: string, value: string) => {
  toolCount += 1;
  const tool = makeTool(`pattern_matcher_${toolCount}`, { inputSchema: schemaWithPattern(pattern) });
  nativeRuns.length = 0;
  const result = await validateToolInput(tool, { value });
  const nativeRunsOnValue = nativeRuns.filter((run) => run.input.includes(value));
  return { ok: result.ok, nativeRunsOnValue };
};

beforeEach(() => {
  nativeRuns.length = 0;
  recordedWorkers.started.length = 0;
  recordedWorkers.onStart = undefined;
  clearUntrustedSchemaCaches();
  vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, input: string) {
    nativeRuns.push({ source: this.source, input: String(input) });
    return originalExec.call(this, input);
  });
  vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (this: RegExp, input: string) {
    nativeRuns.push({ source: this.source, input: String(input) });
    return originalTest.call(this, input);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('no native RegExp runs on the argument text on the calling thread, whatever its source', () => {
  it.each([
    ['a nested quantifier the linear engine represents', '^(a+)+$', 'aaaab'],
    ['a nested quantifier around a property escape', '^(\\p{L}+)+$', 'aaaa1'],
    ['a backreference', '^(a+)+\\1$', 'aaaab'],
    ['a lookaround', '^(?=(a+)+$)a*$', 'aaaab'],
  ])('for %s', async (_case, pattern, value) => {
    const { ok, nativeRunsOnValue } = await checked(pattern, value);
    expect(ok).toBe(false);
    expect(nativeRunsOnValue).toEqual([]);
  });
});

describe('a property escape is matched inside the linear engine', () => {
  it.each([
    ['^\\p{Lu}\\p{Ll}+$', 'Hello', true],
    ['^\\p{Lu}\\p{Ll}+$', 'hello', false],
    ['^\\p{Script=Greek}+$', 'αβγ', true],
    ['^\\p{Script=Greek}+$', 'αβc', false],
    ['^\\p{L}$', '\u{1D49C}', true],
    ['^\\p{L}$', '\u{1D49C}\u{1D49C}', false],
    ['^\\P{N}+$', 'ab', true],
    ['^\\P{N}+$', 'a1', false],
  ])('%s on %j is %s, with no native run on the text and no worker', async (pattern, value, expected) => {
    const { ok, nativeRunsOnValue } = await checked(pattern, value);
    expect(ok).toBe(expected);
    expect(nativeRunsOnValue).toEqual([]);
    expect(recordedWorkers.started).toEqual([]);
  });
});
