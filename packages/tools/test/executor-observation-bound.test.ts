import { describe, expect, it } from 'vitest';
import { WorkTreeObservationError } from '@momonga/tools';
import type { CallOutcome, WorkTreeMark, WorkTreeObserver } from '@momonga/tools';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import type { FakeTimers } from '@momonga/testkit';
import { call, fakeTimedShellHost, makeHarness, makeTool, onFakeTime, toolSetOf } from './harness.ts';

const COMMAND_SCHEMA = { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } as const;

const TOOL_TIMEOUT_MS = 200;

const timers: FakeTimers = createFakeTimers(createFakeClock(0));

const resolvedAfter = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => timers.setTimeout(() => resolve(value), ms));

const sh = () =>
  makeTool('Sh', {
    sideEffect: 'exec',
    subjectKind: 'command',
    kind: 'execute',
    timeoutMs: TOOL_TIMEOUT_MS,
    inputSchema: COMMAND_SCHEMA,
    subject: (input) => ({ kind: 'command', tool: 'Sh', command: String(input['command']) }),
    execute: () => resolvedAfter(TOOL_TIMEOUT_MS / 2, { status: 'completed' as const, output: 'ran', exitCode: 0 }),
  });

const MARK = { tree: 'a'.repeat(40) } as WorkTreeMark;


const untilAborted = (signal: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

const resultOf = (outcome: CallOutcome | undefined) => {
  if (outcome?.kind !== 'result') throw new Error(`expected a result, got ${outcome?.kind}`);
  return outcome.result;
};

const runWith = async (observer: WorkTreeObserver) => {
  const harness = makeHarness({ executor: { workTreeObserver: observer, shellHost: fakeTimedShellHost(timers) } as never });
  const { value: outcomes } = await onFakeTime(timers, harness.executor.runBatch(await harness.input(await toolSetOf(sh()), [call('c1', 'Sh', { command: 'true' }, 'allow_once')])), TOOL_TIMEOUT_MS * 4, 'the observed call');
  return resultOf(outcomes[0]);
};

describe('the observation of file effects is charged to its own bound, not to the tool', () => {
  it('a mark that takes most of the tool limit leaves the tool its whole limit', async () => {
    const result = await runWith({
      mark: () => resolvedAfter((TOOL_TIMEOUT_MS * 3) / 4, MARK),
      changedSince: async () => ({ files: [], mark: MARK, oversized: [], complete: true }),
    });

    expect(result).toMatchObject({ status: 'completed', output: 'ran', files: [] });
  });

  it('a mark that never ends is stopped by its own bound and the result says file effects were not observed', async () => {
    const result = await runWith({
      mark: (signal) => untilAborted(signal),
      changedSince: async () => ({ files: [], mark: MARK, oversized: [], complete: true }),
    });

    expect(result.status).toBe('completed');
    expect(result.output).toBe(`ran\nfile effects were not observed: the observation took longer than ${TOOL_TIMEOUT_MS} ms`);
    expect(result).not.toHaveProperty('files');
  });

  it('a failed observation is named in the result with its reason, not reported as nothing observed', async () => {
    const result = await runWith({
      mark: async () => MARK,
      changedSince: async () => {
        throw new WorkTreeObservationError('git add exited with 128: error: open("secret"): Permission denied');
      },
    });

    expect(result.output).toBe('ran\nfile effects were not observed: git add exited with 128: error: open("secret"): Permission denied');
    expect(result).not.toHaveProperty('files');
  });

  it('files the repository does not track and that are over the size bound are named as not observed', async () => {
    const result = await runWith({
      mark: async () => MARK,
      changedSince: async () => ({ files: [], mark: MARK, oversized: ['/p/big.bin'], complete: true }),
    });

    expect(result.output).toContain('\nfile effects were not observed for files over');
    expect(result.output).toContain('/p/big.bin');
  });
});
