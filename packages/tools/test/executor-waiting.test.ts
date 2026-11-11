import { describe, expect, it } from 'vitest';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';

describe('a tool that asks to wait', () => {
  const waitingTool = (results: Array<'pending' | 'done'>) => {
    const executions: string[] = [];
    const tool = makeTool('Wait', {
      execute: async (_input, ctx) => {
        executions.push(ctx.callId);
        const next = results.shift() ?? 'done';
        if (next === 'pending') return { status: 'pending', awaits: { kind: 'job', jobId: 'bash_x' }, wakeAt: ctx.clock.now() + 5000 };
        return { status: 'completed', output: 'finished' };
      },
    });
    return { tool, executions };
  };

  it('returns a waiting outcome, announces nothing and leaves the record open', async () => {
    const harness = makeHarness();
    const { tool } = waitingTool(['pending']);
    const announced: string[] = [];
    const toolSet = await toolSetOf(tool);
    const [outcome] = await harness.executor.runBatch(
      await harness.input(toolSet, [call('c1', 'Wait', {})], { onOutcome: (result) => void announced.push(result.callId) }),
    );
    expect(outcome).toEqual({ callId: 'c1', kind: 'waiting', awaits: { kind: 'job', jobId: 'bash_x' }, wakeAt: harness.clock.now() + 5000 });
    expect(announced).toEqual([]);
    const key = harness.idempotency.log.find((entry) => entry.op === 'begin')?.key ?? '';
    expect(harness.idempotency.port.get(key)).toMatchObject({ s: 'PENDING' });
    expect(harness.idempotency.log.some((entry) => entry.op === 'complete')).toBe(false);
  });

  it('runs the tool again on the next batch and completes the call when it no longer waits', async () => {
    const harness = makeHarness();
    const { tool, executions } = waitingTool(['pending', 'pending', 'done']);
    const toolSet = await toolSetOf(tool);
    const batch = () => harness.input(toolSet, [call('c1', 'Wait', {})]);
    expect((await harness.executor.runBatch(await batch()))[0]?.kind).toBe('waiting');
    expect((await harness.executor.runBatch(await batch()))[0]?.kind).toBe('waiting');
    const [outcome] = await harness.executor.runBatch(await batch());
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'finished' } });
    expect(executions).toEqual(['c1', 'c1', 'c1']);
    expect(harness.started).toEqual(['c1']);
    expect(harness.idempotency.log.filter((entry) => entry.op === 'complete')).toHaveLength(1);
  });

  it('lets the other calls of the batch finish and announces them', async () => {
    const harness = makeHarness();
    const { tool } = waitingTool(['pending']);
    const toolSet = await toolSetOf(tool, makeTool('Quick'));
    const announced: string[] = [];
    const outcomes = await harness.executor.runBatch(
      await harness.input(toolSet, [call('c1', 'Wait', {}), call('c2', 'Quick', {})], { onOutcome: (result) => void announced.push(result.callId) }),
    );
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['waiting', 'result']);
    expect(announced).toEqual(['c2']);
  });

  it('does not turn the wait into a result when the lease was lost', async () => {
    const harness = makeHarness();
    const { tool } = waitingTool(['pending']);
    const toolSet = await toolSetOf(tool);
    const [outcome] = await harness.executor.runBatch(await harness.input(toolSet, [call('c1', 'Wait', {})], { leaseLost: () => true }));
    expect(outcome).toEqual({ callId: 'c1', kind: 'deferred' });
  });
});
