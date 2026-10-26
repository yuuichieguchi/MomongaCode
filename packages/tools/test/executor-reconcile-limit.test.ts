import { describe, expect, it } from 'vitest';
import type { ToolContext } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { keyFor } from './helpers.ts';

const KEY = keyFor('run-1', 1, 'c1');
const STORED = { path: '/stored', preHash: 'pre', postHash: 'post' };
const LONG = Array.from({ length: 100 }, (_unused, index) => `line-${String(index + 1).padStart(3, '0')}`).join('\n');

const editTool = (outcome: 'already_applied' | 'not_applied' | 'unknown', budgets: number[]) =>
  makeTool('Edit', {
    kind: 'edit',
    sideEffect: 'write',
    prepare: async () => STORED,
    reconcile: async () => ({ outcome, output: LONG }),
    execute: async (_input, ctx: ToolContext) => {
      budgets.push(ctx.outputBudgetChars);
      return { status: 'completed', output: LONG };
    },
  });

const lazyLimit = (value: number) => {
  const calls: number[] = [];
  return { calls, get: async () => {
    calls.push(value);
    return value;
  } };
};

describe('two inline limits in one batch', () => {
  it.for(['already_applied', 'unknown'] as const)('truncates a %s reconciled output at the reconcile limit and never resolves the execution limit', async (outcome) => {
    const harness = makeHarness({ maxInlineOutputChars: 5000 });
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit', prepared: STORED });
    const budgets: number[] = [];
    const execution = lazyLimit(1000);
    const [result] = await harness.executor.runBatch({
      ...harness.input(await toolSetOf(editTool(outcome, budgets)), [call('c1', 'Edit', {}, 'allow_once')]),
      inlineLimitForReconcile: 200,
      inlineLimitForExecution: execution.get,
    });

    if (result?.kind !== 'result') throw new Error('expected a result');
    expect(result.reconciled).toBe(outcome);
    expect(result.result.truncated).toBe(true);
    expect(result.result.output.length).toBeLessThanOrEqual(200);
    expect(execution.calls).toEqual([]);
    expect(budgets).toEqual([]);
  });

  it('resolves the execution limit for a fresh execution and keeps the output inline below it', async () => {
    const harness = makeHarness({ maxInlineOutputChars: 5000 });
    const budgets: number[] = [];
    const execution = lazyLimit(1000);
    const [result] = await harness.executor.runBatch({
      ...harness.input(await toolSetOf(editTool('unknown', budgets)), [call('c1', 'Edit', {}, 'allow_once')]),
      inlineLimitForReconcile: 200,
      inlineLimitForExecution: execution.get,
    });

    if (result?.kind !== 'result') throw new Error('expected a result');
    expect(result.result.output).toBe(LONG);
    expect(execution.calls).toEqual([1000]);
    expect(budgets).toEqual([1000]);
  });

  it('uses the execution limit when a not_applied reconcile re-executes the call', async () => {
    const harness = makeHarness({ maxInlineOutputChars: 5000 });
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit', prepared: STORED });
    const budgets: number[] = [];
    const execution = lazyLimit(300);
    const [result] = await harness.executor.runBatch({
      ...harness.input(await toolSetOf(editTool('not_applied', budgets)), [call('c1', 'Edit', {}, 'allow_once')]),
      inlineLimitForReconcile: 2000,
      inlineLimitForExecution: execution.get,
    });

    if (result?.kind !== 'result') throw new Error('expected a result');
    expect(result.reconciled).toBe('not_applied');
    expect(result.result.truncated).toBe(true);
    expect(result.result.output.length).toBeLessThanOrEqual(300);
    expect(execution.calls).toEqual([300]);
    expect(budgets).toEqual([300]);
  });
});
