import { describe, expect, it } from 'vitest';
import { TransientToolError } from '@momonga/tools';
import type { ToolContext } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { keyFor, until } from './helpers.ts';

const waitForAbort = (ctx: ToolContext): Promise<{ status: 'failed'; output: string }> =>
  new Promise((resolve) => {
    ctx.signal.addEventListener('abort', () => resolve({ status: 'failed', output: 'aborted by signal' }), { once: true });
  });

const outputOf = (outcome: unknown): string => {
  const value = outcome as { kind?: string; result?: { output?: string } };
  if (value.kind !== 'result' || typeof value.result?.output !== 'string') throw new Error('expected a result outcome');
  return value.result.output;
};

const expectUnknownEffects = (output: string): void => {
  expect(output).toMatch(/unknown/i);
  expect(output).toMatch(/inspect/i);
};

describe('timeouts', () => {
  it('fails a read-only tool that exceeds its timeout', async () => {
    const harness = makeHarness();
    const tool = makeTool('Read', { timeoutMs: 30, execute: (_input, ctx) => waitForAbort(ctx) });
    const outcomes = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Read')]));
    expect(outcomes[0]).toMatchObject({ callId: 'c1', kind: 'result', result: { status: 'failed', output: 'Read timed out after 30 ms' } });
  });

  it('computes the timeout from the input when timeoutMs is a function', async () => {
    const harness = makeHarness();
    const tool = makeTool('Read', {
      inputSchema: { type: 'object', properties: { ms: { type: 'integer' } }, additionalProperties: false },
      timeoutMs: (input) => Number(input['ms']),
      execute: (_input, ctx) => waitForAbort(ctx),
    });
    const outcomes = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Read', { ms: 25 })]));
    expect(outputOf(outcomes[0])).toBe('Read timed out after 25 ms');
  });

  it.each([
    ['Write', 'write'],
    ['Bash', 'exec'],
  ] as const)('warns that side effects of a timed out %s are unknown', async (name, sideEffect) => {
    const harness = makeHarness();
    const tool = makeTool(name, { sideEffect, kind: 'edit', timeoutMs: 30, execute: (_input, ctx) => waitForAbort(ctx) });
    const outcomes = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', name, {}, 'allow_once')]));
    const output = outputOf(outcomes[0]);
    expect(output.startsWith(`${name} timed out after 30 ms`)).toBe(true);
    expectUnknownEffects(output);
  });

  it('does not add the unknown-effects warning for read-only tools', async () => {
    const harness = makeHarness();
    const tool = makeTool('Read', { timeoutMs: 30, execute: (_input, ctx) => waitForAbort(ctx) });
    const outcomes = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Read')]));
    expect(outputOf(outcomes[0])).not.toMatch(/inspect/i);
  });

  it('caps the timeout by the remaining run deadline', async () => {
    const harness = makeHarness();
    const tool = makeTool('Read', { timeoutMs: 60_000, execute: (_input, ctx) => waitForAbort(ctx) });
    const started = Date.now();
    const outcomes = await harness.executor.runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Read')], { deadlineAt: harness.clock.now() + 40 }),
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcomes[0]).toMatchObject({ kind: 'result', result: { status: 'failed' } });
  });

  it('records a timed out call as completed so a replay does not re-execute', async () => {
    const harness = makeHarness();
    let executions = 0;
    const tool = makeTool('Bash', {
      sideEffect: 'exec',
      kind: 'execute',
      timeoutMs: 30,
      execute: (_input, ctx) => {
        executions += 1;
        return waitForAbort(ctx);
      },
    });
    const set = await toolSetOf(tool);
    const first = await harness.executor.runBatch(harness.input(set, [call('c1', 'Bash', {}, 'allow_once')]));
    expect(harness.idempotency.stateOf(keyFor('run-1', 1, 'c1'))).toBe('COMPLETED');
    const second = await harness.executor.runBatch(harness.input(set, [call('c1', 'Bash', {}, 'allow_once')]));
    expect(second).toEqual(first);
    expect(executions).toBe(1);
  });

  it('stops waiting for a tool that ignores the abort after at most 2000 ms', { timeout: 15_000 }, async () => {
    const harness = makeHarness();
    const tool = makeTool('Read', { timeoutMs: 20, execute: () => new Promise(() => undefined) });
    const started = Date.now();
    const outcomes = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Read')]));
    const elapsed = Date.now() - started;
    expect(outputOf(outcomes[0])).toBe('Read timed out after 20 ms');
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(6000);
  });
});

describe('cancellation', () => {
  it('fails a running read-only call as cancelled when the batch signal aborts', async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    let running = false;
    const tool = makeTool('Read', {
      execute: (_input, ctx) => {
        running = true;
        return waitForAbort(ctx);
      },
    });
    const pending = harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Read')], { signal: controller.signal }));
    await until(() => running);
    controller.abort();
    const outcomes = await pending;
    expect(outputOf(outcomes[0])).toBe('Read was cancelled');
    expect(harness.idempotency.stateOf(keyFor('run-1', 1, 'c1'))).toBe('COMPLETED');
  });

  it('marks a cancelled write call with the unknown-effects wording and leaves later calls unstarted', async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    const executions: string[] = [];
    const tool = makeTool('Write', {
      kind: 'edit',
      sideEffect: 'write',
      execute: (_input, ctx) => {
        executions.push(ctx.callId);
        return waitForAbort(ctx);
      },
    });
    const pending = harness.executor.runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Write'), call('c2', 'Write')], { signal: controller.signal }),
    );
    await until(() => executions.length === 1);
    controller.abort();
    const outcomes = await pending;
    const first = outputOf(outcomes[0]);
    expect(first.startsWith('Write was cancelled')).toBe(true);
    expectUnknownEffects(first);
    expect(outcomes[1]).toEqual({ callId: 'c2', kind: 'result', result: { status: 'failed', output: 'Write was cancelled' } });
    expect(executions).toEqual(['c1']);
    expect(harness.idempotency.records.has(keyFor('run-1', 1, 'c2'))).toBe(false);
  });

  it('cancels every call without records when the signal is already aborted', async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    controller.abort();
    let executions = 0;
    const tool = makeTool('Read', {
      execute: async () => {
        executions += 1;
        return { status: 'completed', output: 'x' };
      },
    });
    const outcomes = await harness.executor.runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Read'), call('c2', 'Read')], { signal: controller.signal }),
    );
    expect(outcomes).toEqual([
      { callId: 'c1', kind: 'result', result: { status: 'failed', output: 'Read was cancelled' } },
      { callId: 'c2', kind: 'result', result: { status: 'failed', output: 'Read was cancelled' } },
    ]);
    expect(executions).toBe(0);
    expect(harness.idempotency.records.size).toBe(0);
  });
});

describe('transient retry', () => {
  it('retries a read-only tool until it succeeds within the attempt budget', async () => {
    const harness = makeHarness({ attempts: 3 });
    let attempts = 0;
    const tool = makeTool('Read', {
      execute: async () => {
        attempts += 1;
        if (attempts < 3) throw new TransientToolError('busy');
        return { status: 'completed', output: 'third time' };
      },
    });
    const outcomes = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Read')]));
    expect(attempts).toBe(3);
    expect(outcomes[0]).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'third time' } });
  });

  it('fails a read-only tool after the attempt budget is used', async () => {
    const harness = makeHarness({ attempts: 3 });
    let attempts = 0;
    const tool = makeTool('Read', {
      execute: async () => {
        attempts += 1;
        throw new TransientToolError('still busy');
      },
    });
    const outcomes = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Read')]));
    expect(attempts).toBe(3);
    expect(outcomes[0]).toMatchObject({ kind: 'result', result: { status: 'failed' } });
  });

  it.each([
    ['Write', 'write'],
    ['Bash', 'exec'],
  ] as const)('never retries a %s tool', async (name, sideEffect) => {
    const harness = makeHarness({ attempts: 3 });
    let attempts = 0;
    const tool = makeTool(name, {
      sideEffect,
      kind: 'edit',
      execute: async () => {
        attempts += 1;
        throw new TransientToolError('flaky');
      },
    });
    const outcomes = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', name, {}, 'allow_once')]));
    expect(attempts).toBe(1);
    expect(outcomes[0]).toMatchObject({ kind: 'result', result: { status: 'failed' } });
  });

  it('does not retry once the run deadline has passed', async () => {
    const harness = makeHarness({ attempts: 3 });
    let attempts = 0;
    const tool = makeTool('Read', {
      execute: async () => {
        attempts += 1;
        harness.clock.set(harness.clock.now() + 1000);
        throw new TransientToolError('busy');
      },
    });
    const deadlineAt = harness.clock.now() + 500;
    const outcomes = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Read')], { deadlineAt }));
    expect(attempts).toBe(1);
    expect(outcomes[0]).toMatchObject({ kind: 'result', result: { status: 'failed' } });
  });
});
