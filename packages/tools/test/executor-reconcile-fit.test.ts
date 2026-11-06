import { describe, expect, it } from 'vitest';
import type { CallOutputFit, OutputFit, ToolContext } from '@momonga/tools';
import { askingFit, call, callAnsweredBy, charFit, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { keyFor } from './helpers.ts';

const KEY = keyFor('run-1', 1, 'c1');
const STORED = { path: '/stored', preHash: 'pre', postHash: 'post' };
const LONG = Array.from({ length: 100 }, (_unused, index) => `line-${String(index + 1).padStart(3, '0')}`).join('\n');

const editTool = (outcome: 'already_applied' | 'not_applied' | 'unknown', ports: CallOutputFit[]) =>
  makeTool('Edit', {
    kind: 'edit',
    sideEffect: 'write', subjectKind: 'none',
    prepare: async () => STORED,
    reconcile: async () => ({ outcome, output: LONG }),
    execute: async (_input, ctx: ToolContext) => {
      ports.push(ctx.outputFit);
      return { status: 'completed', output: LONG };
    },
  });

const recordingFit = (limit: number) => {
  const readied: number[] = [];
  const readying: OutputFit = {
    ...charFit(limit),
    ready: async () => {
      readied.push(limit);
    },
  };
  return { readied, ...askingFit(readying) };
};

describe('two output fits in one batch', () => {
  it.for(['already_applied', 'unknown'] as const)('cuts a %s reconciled output through the reconcile fit and never readies the execution fit', async (outcome) => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit', prepared: STORED });
    const ports: CallOutputFit[] = [];
    const execution = recordingFit(1000);
    const [result] = await harness.executor.runBatch({
      ...harness.input(await toolSetOf(editTool(outcome, ports)), [call('c1', 'Edit', {}, 'allow_once')]),
      reconcileFit: charFit(200),
      outputFit: execution.port,
    });

    if (result?.kind !== 'result') throw new Error('expected a result');
    expect(result.reconciled).toBe(outcome);
    expect(result.result.truncated).toBe(true);
    expect(result.result.output.length).toBeLessThanOrEqual(200);
    expect(execution.readied).toEqual([]);
    expect(ports).toEqual([]);
  });

  it('readies the execution fit for a fresh execution and keeps the output inline below it', async () => {
    const harness = makeHarness();
    const ports: CallOutputFit[] = [];
    const execution = recordingFit(1000);
    const [result] = await harness.executor.runBatch({
      ...harness.input(await toolSetOf(editTool('unknown', ports)), [call('c1', 'Edit', {}, 'allow_once')]),
      reconcileFit: charFit(200),
      outputFit: execution.port,
    });

    if (result?.kind !== 'result') throw new Error('expected a result');
    expect(result.result.output).toBe(LONG);
    expect(execution.readied.length).toBeGreaterThan(0);
    expect(ports).toHaveLength(1);
    expect(await callAnsweredBy(ports[0] as CallOutputFit, execution)).toEqual({ callId: 'c1', tool: 'Edit' });
  });

  it('uses the execution fit when a not_applied reconcile re-executes the call', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit', prepared: STORED });
    const ports: CallOutputFit[] = [];
    const execution = recordingFit(300);
    const [result] = await harness.executor.runBatch({
      ...harness.input(await toolSetOf(editTool('not_applied', ports)), [call('c1', 'Edit', {}, 'allow_once')]),
      reconcileFit: charFit(2000),
      outputFit: execution.port,
    });

    if (result?.kind !== 'result') throw new Error('expected a result');
    expect(result.reconciled).toBe('not_applied');
    expect(result.result.truncated).toBe(true);
    expect(result.result.output.length).toBeLessThanOrEqual(300);
    expect(execution.readied.length).toBeGreaterThan(0);
    expect(ports).toHaveLength(1);
    expect(await callAnsweredBy(ports[0] as CallOutputFit, execution)).toEqual({ callId: 'c1', tool: 'Edit' });
  });
});
