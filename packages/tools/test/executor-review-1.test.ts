import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ResultOutcome } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import type { Harness } from './harness.ts';
import { keyFor } from './helpers.ts';

const KEY = keyFor('run-1', 1, 'c1');

const untilAborted = (signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

const opsFor = (harness: Harness, key: string): string[] => harness.idempotency.log.filter((entry) => entry.key === key).map((entry) => entry.op);

const refuseSecondCompletion = (harness: Harness): void => {
  const original = harness.idempotency.port.complete;
  harness.idempotency.port.complete = (key, result) => {
    if (harness.idempotency.stateOf(key) === 'COMPLETED') throw new Error(`cannot complete idempotency key "${key}": no record in state PENDING or UNKNOWN`);
    original(key, result);
  };
};

const reconcilingTool = (outcome: 'already_applied' | 'not_applied' | 'unknown') => {
  const seen = { reconciled: 0, executed: 0 };
  const tool = makeTool('Mark', {
    kind: 'edit',
    sideEffect: 'write', subjectKind: 'none',
    reconcile: async () => {
      seen.reconciled += 1;
      return { outcome, output: `reconciled ${outcome}` };
    },
    execute: async () => {
      seen.executed += 1;
      return { status: 'completed', output: 'executed' };
    },
  });
  return { tool, seen };
};

describe('executor lease loss', () => {
  it('makes no idempotency writes and leaves the record PENDING when the batch aborts because the lease was lost', async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    let lost = false;
    const tool = makeTool('Shell', {
      kind: 'execute',
      sideEffect: 'write', subjectKind: 'none',
      execute: async (_input, ctx) => {
        lost = true;
        controller.abort('lease_lost');
        await untilAborted(ctx.signal);
        ctx.attachProcess?.({ pgid: 4242, startedAt: harness.clock.now() });
        return { status: 'failed', output: 'interrupted' };
      },
    });

    await harness.executor.runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Shell')], { signal: controller.signal, leaseLost: () => lost }),
    );

    expect(opsFor(harness, KEY)).toEqual(['begin']);
    expect(harness.idempotency.stateOf(KEY)).toBe('PENDING');
  });

  it('aborts the running tool when the lease is lost', async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    let lost = false;
    const signals: AbortSignal[] = [];
    const tool = makeTool('Shell', {
      kind: 'execute',
      sideEffect: 'write', subjectKind: 'none',
      execute: async (_input, ctx) => {
        signals.push(ctx.signal);
        lost = true;
        controller.abort('lease_lost');
        await untilAborted(ctx.signal);
        return { status: 'failed', output: 'interrupted' };
      },
    });

    await harness.executor.runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Shell')], { signal: controller.signal, leaseLost: () => lost }),
    );

    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
  });

  it('does not throw when the successor already completed the record after the lease was lost', async () => {
    const harness = makeHarness();
    refuseSecondCompletion(harness);
    const controller = new AbortController();
    let lost = false;
    const successorOutcome = { callId: 'c1', kind: 'result', result: { status: 'completed', output: 'successor result' } };
    const tool = makeTool('Shell', {
      kind: 'execute',
      sideEffect: 'write', subjectKind: 'none',
      execute: async (_input, ctx) => {
        lost = true;
        harness.idempotency.records.set(KEY, { kind: 'completed', result: successorOutcome });
        controller.abort('lease_lost');
        await untilAborted(ctx.signal);
        return { status: 'failed', output: 'interrupted' };
      },
    });

    await expect(
      harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Shell')], { signal: controller.signal, leaseLost: () => lost })),
    ).resolves.toBeDefined();

    expect(opsFor(harness, KEY)).toEqual(['begin']);
    expect(harness.idempotency.records.get(KEY)).toEqual({ kind: 'completed', result: successorOutcome });
  });
});

describe('executor recoverOnly', () => {
  it('never executes when the PENDING record was purged between the lookup and begin', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Mark' });
    const originalGet = harness.idempotency.port.get;
    harness.idempotency.port.get = (key) => {
      const found = originalGet(key);
      harness.idempotency.records.delete(key);
      return found;
    };
    const { tool, seen } = reconcilingTool('not_applied');

    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Mark')], { recoverOnly: true }));

    expect(seen.executed).toBe(0);
    expect(harness.started).toEqual([]);
    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', result: { status: 'failed' } });
    expect((outcome as ResultOutcome).result.output).toMatch(/cancelled/);
  });

  it('reports not_applied as a failed reconciled outcome without executing', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Mark' });
    const { tool, seen } = reconcilingTool('not_applied');

    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Mark')], { recoverOnly: true }));

    expect(seen.reconciled).toBe(1);
    expect(seen.executed).toBe(0);
    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', reconciled: 'not_applied', result: { status: 'failed' } });
    expect(harness.idempotency.stateOf(KEY)).toBe('COMPLETED');
  });

  it('still reconciles when the run deadline has already passed', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Mark' });
    const { tool, seen } = reconcilingTool('already_applied');

    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Mark')], { recoverOnly: true, deadlineAt: harness.clock.now() - 1 }),
    );

    expect(seen.reconciled).toBe(1);
    expect(seen.executed).toBe(0);
    expect(outcome).toMatchObject({
      callId: 'c1',
      kind: 'result',
      reconciled: 'already_applied',
      result: { status: 'completed', output: 'reconciled already_applied' },
    });
  });
});

describe('executor admission of a call with an existing record', () => {
  it('reconciles instead of asking for approval and runs the normal post-reconcile path', async () => {
    const harness = makeHarness();
    const target = path.join(harness.layout.project, 'edited.txt');
    fs.writeFileSync(target, 'before');
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit' });
    const seen = { reconciled: 0, executed: 0 };
    const tool = makeTool('Edit', {
      kind: 'edit',
      sideEffect: 'write', subjectKind: 'path',
      subject: () => ({ kind: 'path', tool: 'Edit', paths: [target], access: 'write' }),
      reconcile: async () => {
        seen.reconciled += 1;
        return { outcome: 'not_applied', output: '' };
      },
      execute: async () => {
        seen.executed += 1;
        return { status: 'completed', output: 'edited' };
      },
    });

    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Edit', {}, 'allow_once')], { mode: 'default' }),
    );

    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', reconciled: 'not_applied', result: { status: 'completed', output: 'edited' } });
    expect(seen).toEqual({ reconciled: 1, executed: 1 });
  });

  it('asks for approval before re-executing a not_applied call that carries no approval', async () => {
    const harness = makeHarness();
    const target = path.join(harness.layout.project, 'edited.txt');
    fs.writeFileSync(target, 'before');
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit' });
    const seen = { reconciled: 0, executed: 0 };
    const tool = makeTool('Edit', {
      kind: 'edit',
      sideEffect: 'write', subjectKind: 'path',
      subject: () => ({ kind: 'path', tool: 'Edit', paths: [target], access: 'write' }),
      reconcile: async () => {
        seen.reconciled += 1;
        return { outcome: 'not_applied', output: '' };
      },
      execute: async () => {
        seen.executed += 1;
        return { status: 'completed', output: 'edited' };
      },
    });

    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Edit')], { mode: 'default' }));

    expect(outcome).toMatchObject({ callId: 'c1', kind: 'needs_approval', decision: { kind: 'ask' } });
    expect((outcome as { subjectDigest?: string }).subjectDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(seen).toEqual({ reconciled: 1, executed: 0 });
    expect(harness.idempotency.stateOf(KEY)).toBe('PENDING');
  });
});

describe('executor onOutcome', () => {
  it('reports each call after its onStarted, in call order, for sequential tools', async () => {
    const harness = makeHarness();
    const order: string[] = [];
    const tool = makeTool('Mark', { kind: 'edit', sideEffect: 'write', subjectKind: 'none' });

    await harness.executor.runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Mark'), call('c2', 'Mark')], {
        mode: 'bypassPermissions',
        onStarted: (callId) => {
          order.push(`started:${callId}`);
        },
        onOutcome: (outcome) => {
          order.push(`outcome:${outcome.callId}`);
        },
      }),
    );

    expect(order).toEqual(['started:c1', 'outcome:c1', 'started:c2', 'outcome:c2']);
  });

  it('reports a read-only call only after its onStarted', async () => {
    const harness = makeHarness();
    const order: string[] = [];
    const tool = makeTool('Look');

    await harness.executor.runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Look'), call('c2', 'Look')], {
        onStarted: (callId) => {
          order.push(`started:${callId}`);
        },
        onOutcome: (outcome) => {
          order.push(`outcome:${outcome.callId}`);
        },
      }),
    );

    for (const callId of ['c1', 'c2']) {
      expect(order.indexOf(`started:${callId}`)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(`outcome:${callId}`)).toBeGreaterThan(order.indexOf(`started:${callId}`));
    }
    expect(order).toHaveLength(4);
  });

  it.each([
    ['a sequential', makeTool('Mark', { kind: 'edit', sideEffect: 'write', subjectKind: 'none' }), 'Mark'],
    ['a read-only', makeTool('Look'), 'Look'],
  ] as const)('rejects the batch with the onOutcome error for %s tool', async (_label, tool, name) => {
    const harness = makeHarness();
    const failure = new Error('onOutcome exploded');

    await expect(
      harness.executor.runBatch(
        harness.input(await toolSetOf(tool), [call('c1', name)], {
          mode: 'bypassPermissions',
          onOutcome: () => {
            throw failure;
          },
        }),
      ),
    ).rejects.toBe(failure);
  });
});
