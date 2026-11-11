import { describe, expect, it } from 'vitest';
import { RetiringYield } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { keyFor } from './helpers.ts';

describe('a tool that raises RetiringYield (20.50)', () => {
  it('ends the batch with that error instead of a failed outcome, and leaves the call pending for the next attempt', async () => {
    const harness = makeHarness();
    const tool = makeTool('Edit', {
      kind: 'edit',
      sideEffect: 'write',
      subjectKind: 'none',
      execute: async () => {
        throw new RetiringYield();
      },
    });

    await expect(harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Edit', {}, 'allow_once')]))).rejects.toBeInstanceOf(RetiringYield);

    expect(harness.idempotency.stateOf(keyFor('run-1', 1, 'c1'))).toBe('PENDING');
  });
});
