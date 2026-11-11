import { describe, expect, it } from 'vitest';
import type { ReconcileResult, ToolIdempotencyRecord } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { keyFor, ruleFor } from './helpers.ts';

const KEY = keyFor('run-1', 1, 'c1');

const tracked = (name: string, overrides: Parameters<typeof makeTool>[1] = {}) => {
  const executions: string[] = [];
  const tool = makeTool(name, {
    execute: async () => {
      executions.push(name);
      return { status: 'completed', output: `${name} fresh` };
    },
    ...overrides,
  });
  return { tool, executions };
};

describe('idempotency NEW and COMPLETED', () => {
  it('replays a completed call with the identical outcome and without execute or onStarted', async () => {
    const harness = makeHarness();
    const { tool, executions } = tracked('Write', { kind: 'edit', sideEffect: 'write', subjectKind: 'none' });
    const set = await toolSetOf(tool);
    const first = await harness.executor.runBatch(await harness.input(set, [call('c1', 'Write')]));
    const second = await harness.executor.runBatch(await harness.input(set, [call('c1', 'Write')]));
    expect(second).toEqual(first);
    expect(executions).toEqual(['Write']);
    expect(harness.started).toEqual(['c1']);
    expect(harness.idempotency.log.filter((entry) => entry.op === 'complete')).toHaveLength(1);
  });

  it('stores exactly the returned outcome', async () => {
    const harness = makeHarness();
    const { tool } = tracked('Read');
    const [outcome] = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Read')]));
    const completion = harness.idempotency.log.find((entry) => entry.op === 'complete');
    expect(completion?.op === 'complete' ? completion.result : undefined).toEqual(outcome);
  });

  it('uses distinct keys per run, step and call id', async () => {
    const harness = makeHarness();
    const { tool, executions } = tracked('Read');
    const set = await toolSetOf(tool);
    await harness.executor.runBatch(await harness.input(set, [call('c1', 'Read')]));
    await harness.executor.runBatch(await harness.input(set, [call('c1', 'Read')], { step: 2 }));
    await harness.executor.runBatch(await harness.input(set, [call('c1', 'Read')], { runId: 'run-2' }));
    await harness.executor.runBatch(await harness.input(set, [call('c2', 'Read')]));
    expect(executions).toHaveLength(4);
    expect([...harness.idempotency.records.keys()].sort()).toEqual(
      [keyFor('run-1', 1, 'c1'), keyFor('run-1', 2, 'c1'), keyFor('run-2', 1, 'c1'), keyFor('run-1', 1, 'c2')].sort(),
    );
  });
});

describe('idempotency PENDING and UNKNOWN reconcile', () => {
  it.each(['PENDING', 'UNKNOWN'] as const)('re-executes a read-only tool without reconcile from %s as not_applied', async (state) => {
    const harness = makeHarness();
    const { tool, executions } = tracked('Read');
    harness.idempotency.seed(KEY, state, { tool: 'Read' });
    const outcomes = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Read')]));
    expect(executions).toEqual(['Read']);
    expect(outcomes[0]).toMatchObject({ callId: 'c1', kind: 'result', result: { status: 'completed', output: 'Read fresh' }, reconciled: 'not_applied' });
    expect(harness.idempotency.stateOf(KEY)).toBe('COMPLETED');
  });

  it.each([
    ['Write', 'write', 'PENDING'],
    ['Write', 'write', 'UNKNOWN'],
    ['Bash', 'exec', 'PENDING'],
    ['Bash', 'exec', 'UNKNOWN'],
  ] as const)('does not re-run %s (%s) from %s and reports an unknown effect', async (name, sideEffect, state) => {
    const harness = makeHarness();
    const { tool, executions } = tracked(name, { sideEffect, subjectKind: 'none', kind: sideEffect === 'exec' ? 'execute' : 'edit' });
    harness.idempotency.seed(KEY, state, { tool: name });
    const outcomes = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', name, {}, 'allow_once')]));
    expect(executions).toEqual([]);
    const outcome = outcomes[0];
    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', result: { status: 'failed' }, reconciled: 'unknown' });
    if (outcome?.kind !== 'result') throw new Error('expected result');
    expect(outcome.result.output).toMatch(/interrupted/i);
    expect(outcome.result.output).toMatch(/unknown/i);
    expect(outcome.result.output).toMatch(/inspect/i);
    expect(harness.idempotency.stateOf(KEY)).toBe('COMPLETED');
    const replay = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', name, {}, 'allow_once')]));
    expect(replay).toEqual(outcomes);
    expect(executions).toEqual([]);
  });

  it('passes the stored record to the tool reconcile and returns already_applied as completed', async () => {
    const harness = makeHarness();
    const seen: ToolIdempotencyRecord[] = [];
    const { tool, executions } = tracked('Write', {
      kind: 'edit',
      sideEffect: 'write', subjectKind: 'none',
      reconcile: async (_input, record) => {
        seen.push(record);
        return { outcome: 'already_applied', output: 'file already has the new content' };
      },
    });
    const rec = harness.idempotency.seed(KEY, 'PENDING', { tool: 'Write', prepared: { sha: 'abc' } });
    const outcomes = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Write')]));
    expect(seen).toEqual([rec]);
    expect(executions).toEqual([]);
    expect(outcomes).toEqual([
      {
        callId: 'c1',
        kind: 'result',
        result: { status: 'completed', output: 'file already has the new content' },
        idemKey: KEY,
        reconciled: 'already_applied',
      },
    ]);
    expect(harness.idempotency.stateOf(KEY)).toBe('COMPLETED');
  });

  it('returns a tool-reported unknown reconcile as failed and completes the record', async () => {
    const harness = makeHarness();
    const reconcile = async (): Promise<ReconcileResult> => ({ outcome: 'unknown', output: 'cannot tell whether the command ran' });
    const { tool, executions } = tracked('Bash', { kind: 'execute', sideEffect: 'exec', subjectKind: 'none', reconcile });
    harness.idempotency.seed(KEY, 'UNKNOWN', { tool: 'Bash' });
    const outcomes = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Bash')]));
    expect(executions).toEqual([]);
    expect(outcomes[0]).toMatchObject({
      kind: 'result',
      result: { status: 'failed', output: 'cannot tell whether the command ran' },
      reconciled: 'unknown',
    });
    expect(harness.idempotency.stateOf(KEY)).toBe('COMPLETED');
  });

  it('executes normally when the tool reconcile reports not_applied', async () => {
    const harness = makeHarness();
    const { tool, executions } = tracked('Write', {
      kind: 'edit',
      sideEffect: 'write', subjectKind: 'none',
      reconcile: async () => ({ outcome: 'not_applied', output: 'file unchanged' }),
    });
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Write' });
    const outcomes = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Write')]));
    expect(executions).toEqual(['Write']);
    expect(outcomes[0]).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'Write fresh' }, reconciled: 'not_applied' });
    expect(harness.idempotency.stateOf(KEY)).toBe('COMPLETED');
  });

  it('uses the tool reconcile for read-only tools too', async () => {
    const harness = makeHarness();
    const { tool, executions } = tracked('Read', { reconcile: async () => ({ outcome: 'already_applied', output: 'cached' }) });
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Read' });
    const outcomes = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Read')]));
    expect(executions).toEqual([]);
    expect(outcomes[0]).toMatchObject({ result: { status: 'completed', output: 'cached' }, reconciled: 'already_applied' });
  });
});

describe('idempotency lookup before decide', () => {
  const writeTool = () => tracked('Write', { kind: 'edit', sideEffect: 'write', subjectKind: 'none' });

  it.each([
    ['a deny rule', { rules: 'deny' as const }],
    ['plan mode', { mode: 'plan' as const }],
  ])('returns a completed outcome even when %s would now refuse the call', async (_label, change) => {
    const harness = makeHarness();
    const { tool, executions } = writeTool();
    const set = await toolSetOf(tool);
    const first = await harness.executor.runBatch(await harness.input(set, [call('c1', 'Write')]));
    const extra =
      'rules' in change
        ? { rules: [ruleFor(harness.layout)('deny', 'Write')] }
        : { mode: change.mode };
    const second = await harness.executor.runBatch(await harness.input(set, [call('c1', 'Write')], extra));
    expect(second).toEqual(first);
    expect(second[0]).toMatchObject({ idemKey: KEY });
    expect(executions).toEqual(['Write']);
    expect(harness.started).toEqual(['c1']);
    expect(harness.idempotency.log.filter((entry) => entry.op === 'begin')).toHaveLength(1);
  });

  it('returns a completed outcome for a call that would now ask, without approval', async () => {
    const harness = makeHarness();
    const { tool, executions } = tracked('Bash', {
      kind: 'execute',
      sideEffect: 'exec', subjectKind: 'command',
      subject: () => ({ kind: 'command', tool: 'Bash', command: 'make build' }),
    });
    const set = await toolSetOf(tool);
    const first = await harness.executor.runBatch(await harness.input(set, [call('c1', 'Bash', {}, 'allow_once')]));
    const second = await harness.executor.runBatch(await harness.input(set, [call('c1', 'Bash')]));
    expect(second).toEqual(first);
    expect(executions).toEqual(['Bash']);
    expect(harness.started).toEqual(['c1']);
  });

  it('still validates and computes the subject before the lookup', async () => {
    const harness = makeHarness();
    const { tool } = writeTool();
    const set = await toolSetOf(tool);
    await harness.executor.runBatch(await harness.input(set, [call('c1', 'Write')]));
    const lookupsBefore = harness.idempotency.lookups.length;
    const [outcome] = await harness.executor.runBatch(await harness.input(set, [call('c1', 'Write', { extra: 1 })]));
    expect(outcome).toEqual({ callId: 'c1', kind: 'result', result: { status: 'failed', output: 'Invalid input for Write:\n- (root): unknown property "extra"' } });
    expect(harness.idempotency.lookups).toHaveLength(lookupsBefore);
  });

  it('looks up the key and proceeds normally when it is missing', async () => {
    const harness = makeHarness();
    const { tool, executions } = writeTool();
    const outcomes = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Write')]));
    expect(harness.idempotency.lookups).toEqual([KEY]);
    expect(executions).toEqual(['Write']);
    expect(outcomes[0]).toMatchObject({ kind: 'result', result: { status: 'completed' }, idemKey: KEY });
    const begins = harness.idempotency.log.filter((entry) => entry.op === 'begin');
    expect(begins.map((entry) => (entry.op === 'begin' ? entry.s : undefined))).toEqual(['NEW']);
  });

  it('creates no record when a looked-up call is then denied, and omits idemKey', async () => {
    const harness = makeHarness();
    const { tool, executions } = writeTool();
    const rules = [ruleFor(harness.layout)('deny', 'Write')];
    const outcomes = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Write')], { rules }));
    expect(outcomes[0]).toMatchObject({ kind: 'result', result: { status: 'failed' } });
    expect(outcomes[0]).not.toHaveProperty('idemKey');
    expect(executions).toEqual([]);
    expect(harness.idempotency.records.size).toBe(0);
  });
});
