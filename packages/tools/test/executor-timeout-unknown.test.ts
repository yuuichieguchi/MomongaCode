import { describe, expect, it } from 'vitest';
import type { ToolContext } from '@momonga/tools';
import { waitFor } from '@momonga/testkit';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { keyFor } from './helpers.ts';

const waitForAbort = (ctx: ToolContext): Promise<{ status: 'failed'; output: string }> =>
  new Promise((resolve) => {
    ctx.signal.addEventListener('abort', () => resolve({ status: 'failed', output: 'aborted by signal' }), { once: true });
  });

const resultOf = (outcome: unknown): { reconciled?: string; interrupted?: string; output: string } => {
  const value = outcome as { kind?: string; reconciled?: string; interrupted?: string; result?: { output?: string } };
  if (value.kind !== 'result' || typeof value.result?.output !== 'string') throw new Error('expected a result outcome');
  return {
    output: value.result.output,
    ...(value.reconciled === undefined ? {} : { reconciled: value.reconciled }),
    ...(value.interrupted === undefined ? {} : { interrupted: value.interrupted }),
  };
};

const editLike = (writesBeforeTimeout: boolean) => {
  const file = { written: false };
  const tool = makeTool('Edit', {
    kind: 'edit',
    sideEffect: 'write',
    subjectKind: 'none',
    timeoutMs: 30,
    reconcile: async () => (file.written ? { outcome: 'already_applied', output: 'the edit is on disk' } : { outcome: 'not_applied', output: 'the file is unchanged' }),
    execute: (_input, ctx) => {
      if (writesBeforeTimeout) file.written = true;
      return waitForAbort(ctx);
    },
  });
  return { tool, file };
};

describe('a live timeout settles through the reconcile of the tool', () => {
  it('reports a Bash-like call without its own result as reconciled unknown, interrupted by timeout, keeping the timeout sentence', async () => {
    const harness = makeHarness();
    const tool = makeTool('Bash', { sideEffect: 'exec', subjectKind: 'none', kind: 'execute', timeoutMs: 30, execute: (_input, ctx) => waitForAbort(ctx) });
    const outcomes = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Bash', {}, 'allow_once')]));
    const settled = resultOf(outcomes[0]);
    expect(settled.reconciled).toBe('unknown');
    expect(settled.interrupted).toBe('timeout');
    expect(settled.output.startsWith('Bash timed out after 30 ms')).toBe(true);
    expect(harness.idempotency.stateOf(keyFor('run-1', 1, 'c1'))).toBe('COMPLETED');
  });

  it('reports an Edit-like tool that wrote before its deadline as already_applied', async () => {
    const harness = makeHarness();
    const { tool, file } = editLike(true);
    const outcomes = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Edit', {}, 'allow_once')]));
    expect(file.written).toBe(true);
    const settled = resultOf(outcomes[0]);
    expect(settled.reconciled).toBe('already_applied');
    expect(settled.interrupted).toBe('timeout');
    expect(outcomes[0]).toMatchObject({ result: { status: 'completed' } });
  });

  it('reports an Edit-like tool that had not written at its deadline as not_applied', async () => {
    const harness = makeHarness();
    const { tool, file } = editLike(false);
    const outcomes = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Edit', {}, 'allow_once')]));
    expect(file.written).toBe(false);
    const settled = resultOf(outcomes[0]);
    expect(settled.reconciled).toBe('not_applied');
    expect(settled.interrupted).toBe('timeout');
  });

  it('reports a read-only tool timeout as not_applied, interrupted by timeout, with the plain timeout text', async () => {
    const harness = makeHarness();
    const tool = makeTool('Read', { timeoutMs: 30, execute: (_input, ctx) => waitForAbort(ctx) });
    const outcomes = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Read')]));
    const settled = resultOf(outcomes[0]);
    expect(settled.reconciled).toBe('not_applied');
    expect(settled.interrupted).toBe('timeout');
    expect(settled.output).toBe('Read timed out after 30 ms');
  });

  it('marks a cancelled Bash-like call as reconciled unknown, interrupted by cancel', async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    let running = false;
    const tool = makeTool('Bash', {
      sideEffect: 'exec',
      subjectKind: 'none',
      kind: 'execute',
      execute: (_input, ctx) => {
        running = true;
        return waitForAbort(ctx);
      },
    });
    const pending = harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Bash', {}, 'allow_once')], { signal: controller.signal }));
    await waitFor(() => running, { description: '() => running' });
    controller.abort();
    const settled = resultOf((await pending)[0]);
    expect(settled.reconciled).toBe('unknown');
    expect(settled.interrupted).toBe('cancelled');
    expect(settled.output.startsWith('Bash was cancelled')).toBe(true);
  });

  it('returns the stored unknown outcome on a re-issue of the same call without a second execution', async () => {
    const harness = makeHarness();
    let executions = 0;
    const tool = makeTool('Bash', {
      sideEffect: 'exec',
      subjectKind: 'none',
      kind: 'execute',
      timeoutMs: 30,
      execute: (_input, ctx) => {
        executions += 1;
        return waitForAbort(ctx);
      },
    });
    const set = await toolSetOf(tool);
    const first = await harness.executor.runBatch(await harness.input(set, [call('c1', 'Bash', {}, 'allow_once')]));
    const second = await harness.executor.runBatch(await harness.input(set, [call('c1', 'Bash', {}, 'allow_once')]));
    expect(resultOf(first[0]).reconciled).toBe('unknown');
    expect(resultOf(second[0]).reconciled).toBe('unknown');
    expect(executions).toBe(1);
  });
});
