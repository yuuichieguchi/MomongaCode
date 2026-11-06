import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PATTERN_CHECK_LIMIT_MS, clearUntrustedSchemaCaches } from '@momonga/foundation';
import { validateToolInput } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { recordedWorkers } from './worker-record.ts';

vi.mock('node:worker_threads', async (importOriginal) => (await import('./worker-record.ts')).recordingWorkerModule(importOriginal as never));
vi.mock('worker_threads', async (importOriginal) => (await import('./worker-record.ts')).recordingWorkerModule(importOriginal as never));

const INJECTED_LIMIT_MS = 2000;
const NEVER_FINISHING_INPUT = `${'a'.repeat(48)}b`;

const BACKREFERENCE = '^(a+)+\\1$';
const LOOKAROUND = '^(?=(a+)+$)a*$';

const schemaWithPattern = (pattern: string) => ({
  type: 'object',
  properties: { value: { type: 'string', pattern } },
  required: ['value'],
  additionalProperties: false,
});

const toolWith = (name: string, pattern: string) => makeTool(name, { inputSchema: schemaWithPattern(pattern) });

const expectSeamPresent = (): void => {
  expect(PATTERN_CHECK_LIMIT_MS).toBe(5000);
};

const validate = (tool: ReturnType<typeof makeTool>, value: string, options: { signal?: AbortSignal; patternCheckLimitMs?: number }) =>
  (validateToolInput as unknown as (tool: unknown, raw: unknown, options: unknown) => Promise<{ ok: boolean; reason?: string; message?: string }>)(tool, { value }, options);

beforeEach(() => {
  recordedWorkers.started.length = 0;
  recordedWorkers.onStart = undefined;
  clearUntrustedSchemaCaches();
});

describe('a backreference or lookaround pattern is checked in a worker thread', () => {
  it.each([
    ['^(a+)-\\1$', 'aa-aa', true],
    ['^(a+)-\\1$', 'aa-a', false],
    ['^(?!x)\\w+$', 'abc', true],
    ['^(?!x)\\w+$', 'xbc', false],
    ['^\\w+(?<=c)$', 'abc', true],
    ['^\\w+(?<=c)$', 'abd', false],
  ])('%s on %j gives the ECMA-262 answer %s', async (pattern, value, expected) => {
    expectSeamPresent();
    const result = await validate(toolWith('Match', pattern), value, {});
    expect(result.ok).toBe(expected);
  });
});

describe('a hostile pattern at the limit', () => {
  it.each([
    ['backreference', BACKREFERENCE],
    ['lookaround', LOOKAROUND],
  ])('is refused as not checked for a %s, with the worker exited', async (_kind, pattern) => {
    expectSeamPresent();
    const result = await validate(toolWith('Hostile', pattern), NEVER_FINISHING_INPUT, { patternCheckLimitMs: INJECTED_LIMIT_MS });
    expect(result).toEqual({
      ok: false,
      reason: 'not-checked',
      message: `The arguments of Hostile could not be checked against its schema within ${INJECTED_LIMIT_MS / 1000} seconds: the pattern of value is too costly to match.`,
    });
    expect(recordedWorkers.started.length).toBe(1);
    expect(recordedWorkers.started[0]!.exited).toBe(true);
  });

  it('lets a timer scheduled before the check fire before the check ends', async () => {
    expectSeamPresent();
    const order: string[] = [];
    setTimeout(() => order.push('timer'), 0);
    const pending = validate(toolWith('Hostile', BACKREFERENCE), NEVER_FINISHING_INPUT, { patternCheckLimitMs: INJECTED_LIMIT_MS }).then((result) => {
      order.push('check');
      return result;
    });
    expect(order).toEqual([]);
    const result = await pending;
    expect(result.reason).toBe('not-checked');
    expect(order).toEqual(['timer', 'check']);
  });
});

describe('a stop signal during the check', () => {
  it('ends the check stopped, with the worker exited, before the limit', async () => {
    expectSeamPresent();
    const controller = new AbortController();
    recordedWorkers.onStart = () => setImmediate(() => controller.abort());
    const result = await validate(toolWith('Hostile', BACKREFERENCE), NEVER_FINISHING_INPUT, { signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('stopped');
    expect(recordedWorkers.started.length).toBe(1);
    expect(recordedWorkers.started[0]!.exited).toBe(true);
  });

  it('ends an executor call the way a stopped call ends today', async () => {
    expectSeamPresent();
    const harness = makeHarness();
    const controller = new AbortController();
    recordedWorkers.onStart = () => setImmediate(() => controller.abort());
    const tool = toolWith('Hostile', BACKREFERENCE);
    const outcomes = await harness.executor.runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Hostile', { value: NEVER_FINISHING_INPUT })], { signal: controller.signal }),
    );
    expect(outcomes[0]).toMatchObject({ callId: 'c1', kind: 'result', result: { status: 'failed', output: 'Hostile was cancelled' } });
    expect(recordedWorkers.started.length).toBe(1);
    expect(recordedWorkers.started[0]!.exited).toBe(true);
  });
});
