import { FAKE_LEASE, fakePolicyFilesystem, hostFilesystemOf } from '@momonga/testkit';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createToolExecutor } from '@momonga/tools';
import { call, expectedSubjectDigest, makeHarness, makeTool, toolSetOf } from './harness.ts';
import type { Harness } from './harness.ts';
import { keyFor, ruleFor } from './helpers.ts';

const KEY = keyFor('run-1', 1, 'c1');

const executorWhoseRecordVanishesAfterGet = (harness: Harness) => {
  const inner = harness.idempotency.port;
  const vanishingPort = {
    ...inner,
    get(key: string) {
      const snapshot = inner.get(key);
      harness.idempotency.records.delete(key);
      return snapshot;
    },
  };
  return createToolExecutor({ fs: hostFilesystemOf(fakePolicyFilesystem()), ...FAKE_LEASE,
    idempotency: vanishingPort,
    blobs: harness.blobs.port,
    clock: harness.clock,
    processMarkerDir: harness.markerDir,
    callLockDir: harness.callLockDir,
    kernelLock: harness.kernelLock,
    onWarning: () => undefined,
  });
};

const setup = (reconcileOutcome: 'not_applied' | 'unknown' = 'not_applied') => {
  const harness = makeHarness();
  harness.idempotency.seed(KEY, 'PENDING', { tool: 'Write', prepared: { generation: 'stale' } });
  const target = path.join(harness.layout.project, 'a.txt');
  const subject = { kind: 'path' as const, tool: 'Write', paths: [target], access: 'write' as const };
  let executed = 0;
  const preparedSeen: unknown[] = [];
  let prepareCalls = 0;
  const tool = makeTool('Write', {
    kind: 'edit',
    sideEffect: 'write', subjectKind: 'path',
    subject: () => subject,
    reconcile: async () => ({ outcome: reconcileOutcome, output: '' }),
    prepare: async () => {
      prepareCalls += 1;
      return { generation: 'fresh' };
    },
    execute: async (_input, _ctx, prepared) => {
      executed += 1;
      preparedSeen.push(prepared);
      return { status: 'completed', output: 'written' };
    },
  });
  return { harness, tool, subject, executor: executorWhoseRecordVanishesAfterGet(harness), executions: () => executed, preparedSeen, prepareCalls: () => prepareCalls };
};

describe('executor gates a call whose recovered record vanished before begin', () => {
  it('fails with Permission denied and never executes under a deny rule', async () => {
    const { harness, tool, executor, executions } = setup();

    const [outcome] = await executor.runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Write')], { rules: [ruleFor(harness.layout)('deny', 'Write')] }),
    );

    expect(outcome?.kind).toBe('result');
    expect((outcome as { result: { status: string } }).result.status).toBe('failed');
    expect((outcome as { result: { output: string } }).result.output).toMatch(/^Permission denied/);
    expect(executions()).toBe(0);
    expect(harness.started).toEqual([]);
    expect(outcome).not.toHaveProperty('idemKey');
    expect(harness.idempotency.stateOf(KEY)).toBeUndefined();
  });

  it('returns needs_approval with the subject digest and never executes when the policy asks', async () => {
    const { harness, tool, subject, executor, executions } = setup();

    const [outcome] = await executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Write')], { mode: 'default' }));

    expect(outcome).toMatchObject({ callId: 'c1', kind: 'needs_approval', subjectDigest: expectedSubjectDigest(subject, harness.layout.project) });
    expect(executions()).toBe(0);
    expect(harness.started).toEqual([]);
    expect(harness.idempotency.stateOf(KEY)).toBeUndefined();
  });

  it('executes the approved follow-up exactly once even when reconcile would report unknown', async () => {
    const { harness, tool, executor, executions } = setup('unknown');
    const toolSet = await toolSetOf(tool);

    const [asked] = await executor.runBatch(harness.input(toolSet, [call('c1', 'Write')], { mode: 'default' }));
    expect(asked?.kind).toBe('needs_approval');

    const [approved] = await harness.executor.runBatch(harness.input(toolSet, [call('c1', 'Write', {}, 'allow_once')], { mode: 'default' }));

    expect(approved).toMatchObject({ callId: 'c1', kind: 'result', result: { status: 'completed', output: 'written' } });
    expect(executions()).toBe(1);
    expect(harness.started).toEqual(['c1']);
    expect(harness.idempotency.stateOf(KEY)).toBe('COMPLETED');
    expect(harness.idempotency.records.get(KEY)).toMatchObject({ kind: 'completed', result: { kind: 'result', result: { status: 'completed', output: 'written' } } });
  });

  it('runs a fresh prepare instead of reusing the vanished record prepared meta', async () => {
    const { harness, tool, executor, preparedSeen, prepareCalls } = setup();

    await executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Write')], { rules: [ruleFor(harness.layout)('allow', 'Write')] }));

    expect(prepareCalls()).toBe(1);
    expect(preparedSeen).toEqual([{ generation: 'fresh' }]);
  });

  it('executes exactly once when the call carries a matching approval', async () => {
    const { harness, tool, executor, executions } = setup();

    const [outcome] = await executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Write', {}, 'allow_once')], { mode: 'default' }));

    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', result: { status: 'completed', output: 'written' } });
    expect(executions()).toBe(1);
    expect(harness.started).toEqual(['c1']);
  });

  it('executes exactly once under an allow rule', async () => {
    const { harness, tool, executor, executions } = setup();

    const [outcome] = await executor.runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Write')], { rules: [ruleFor(harness.layout)('allow', 'Write')] }),
    );

    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', result: { status: 'completed', output: 'written' } });
    expect(executions()).toBe(1);
    expect(harness.started).toEqual(['c1']);
  });

  it('cancels a recoverOnly call whose record vanished without preparing, executing, or recording', async () => {
    const { harness, tool, executor, executions, prepareCalls } = setup();

    const [outcome] = await executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Write')], { recoverOnly: true }));

    expect(outcome?.kind).toBe('result');
    expect((outcome as { result: { status: string } }).result.status).toBe('failed');
    expect((outcome as { result: { output: string } }).result.output).toMatch(/was cancelled/);
    expect(executions()).toBe(0);
    expect(prepareCalls()).toBe(0);
    expect(harness.started).toEqual([]);
    expect(harness.idempotency.stateOf(KEY)).toBeUndefined();
  });
});
