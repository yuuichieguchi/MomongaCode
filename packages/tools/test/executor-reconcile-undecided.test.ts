import { describe, expect, it } from 'vitest';
import { ReconcileUndecidedError } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { keyFor } from './helpers.ts';

const KEY = keyFor('run-1', 1, 'c1');

const failingReconcile = makeTool('Mark', {
  kind: 'edit',
  sideEffect: 'write',
  subjectKind: 'path',
  subject: () => ({ kind: 'path', tool: 'Mark', paths: ['/somewhere/else'], access: 'write' }),
  reconcile: async () => {
    throw new Error('the sandbox policy is invalid: the session tmp dir is a root');
  },
  execute: async () => ({ status: 'completed', output: 'executed' }),
});

describe('a reconcile that cannot decide its operation', () => {
  it('fails the batch with its reason and keeps the record for the next attempt', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Mark' });

    const failure = await harness.executor.runBatch(await harness.input(await toolSetOf(failingReconcile), [call('c1', 'Mark')], { recoverOnly: true })).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ReconcileUndecidedError);
    expect((failure as Error).message).toContain('the session tmp dir is a root');
    expect(harness.idempotency.stateOf(KEY)).toBe('PENDING');
  });
});
