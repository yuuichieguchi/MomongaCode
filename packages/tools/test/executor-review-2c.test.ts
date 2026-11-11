import { nodeFileSystem, systemRandom } from '@momonga/foundation';
import { UNCONFIGURED_NETWORK, FAKE_LEASE, createFakeClock, createFakeTimers, fakePolicyFilesystem, hostFilesystemOf, testProcessInspector } from '@momonga/testkit';
import type { FakeTimers } from '@momonga/testkit';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createToolExecutor, nodeShellHost } from '@momonga/tools';
import type { ReconcileContext } from '@momonga/tools';
import { call, fakeTimedShellHost, makeHarness, makeTool, onFakeTime, toolSetOf } from './harness.ts';
import type { Harness } from './harness.ts';
import { keyFor, minimalPolicyFor } from './helpers.ts';
import { momongaLayout } from '@momonga/foundation';

const KEY = keyFor('run-1', 1, 'c1');

const boundedExecutor = (harness: Harness, capMs: number, graceMs: number, timers?: FakeTimers) =>
  createToolExecutor({
    layout: momongaLayout(harness.layout.home, process.platform, process.env),
    reap: { inspector: testProcessInspector() },
    shellHost: timers === undefined ? nodeShellHost() : fakeTimedShellHost(timers),
    random: systemRandom,
    files: nodeFileSystem, outboundNetwork: UNCONFIGURED_NETWORK, fs: hostFilesystemOf(fakePolicyFilesystem()), ...FAKE_LEASE,
    idempotency: harness.idempotency.port,
    blobs: harness.blobs.port,
    clock: harness.clock,
    processMarkerDir: harness.markerDir,
    callLockDir: harness.callLockDir,
    kernelLock: harness.kernelLock,
    onWarning: () => undefined,
    reconcileCapMs: capMs,
    reconcileGraceMs: graceMs,
  });

describe('executor defers later calls after a post-reconcile needs_approval', () => {
  it('defers the Write after a concurrent read whose recovered re-execution now asks', async () => {
    const harness = makeHarness();
    const outside = path.join(harness.layout.root, 'outside.txt');
    fs.writeFileSync(outside, 'data');
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Read' });
    const executed: string[] = [];
    const read = makeTool('Read', {
      kind: 'read',
      sideEffect: 'read_only',
      subject: () => ({ kind: 'path', tool: 'Read', paths: [outside], access: 'read' }),
      reconcile: async () => ({ outcome: 'not_applied', output: '' }),
      execute: async (_input, ctx) => {
        executed.push(ctx.callId);
        return { status: 'completed', output: 'read' };
      },
    });
    const mark = makeTool('Mark', {
      kind: 'edit',
      sideEffect: 'write', subjectKind: 'none',
      execute: async (_input, ctx) => {
        executed.push(ctx.callId);
        return { status: 'completed', output: 'marked' };
      },
    });

    const outcomes = await harness.executor.runBatch(
      await harness.input(await toolSetOf(read, mark), [call('c1', 'Read'), call('c2', 'Mark')], { mode: 'manual' }),
    );

    expect(outcomes.map((outcome) => [outcome.callId, outcome.kind])).toEqual([
      ['c1', 'needs_approval'],
      ['c2', 'deferred'],
    ]);
    expect(executed).toEqual([]);
  });
});

describe('executor distrusts a reconcile that settled after the cap', () => {
  it('completes the record as unknown and never executes when not_applied arrives inside the grace window', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Mark' });
    let executed = 0;
    const timers = createFakeTimers(createFakeClock(0));
    const tool = makeTool('Mark', {
      kind: 'edit',
      sideEffect: 'write', subjectKind: 'none',
      reconcile: async () => {
        await new Promise<void>((resolve) => timers.setTimeout(() => resolve(), 60));
        return { outcome: 'not_applied', output: '' };
      },
      execute: async () => {
        executed += 1;
        return { status: 'completed', output: 'executed' };
      },
    });

    const { value: outcomes } = await onFakeTime(
      timers,
      boundedExecutor(harness, 20, 1_000, timers).runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Mark')], { mode: 'bypassPermissions' })),
      2_000,
      'the outcome of a reconcile that settles inside the grace window',
    );
    const [outcome] = outcomes;

    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', reconciled: 'unknown', result: { status: 'failed' } });
    expect(executed).toBe(0);
    expect(harness.idempotency.records.get(KEY)).toMatchObject({ kind: 'completed', result: { reconciled: 'unknown' } });
  });
});

describe('executor closes the tool context of an abandoned reconcile', () => {
  it('drops update and attachProcess calls made after the executor gave up', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Mark' });
    let lateContext: ReconcileContext | undefined;
    const updates: string[] = [];
    const tool = makeTool('Mark', {
      kind: 'edit',
      sideEffect: 'write', subjectKind: 'none',
      reconcile: (_input, _record, ctx) => {
        lateContext = ctx;
        return new Promise(() => undefined);
      },
    });

    const [outcome] = await boundedExecutor(harness, 20, 20).runBatch(
      await harness.input(await toolSetOf(tool), [call('c1', 'Mark')], {
        mode: 'bypassPermissions',
        onUpdate: (callId) => {
          updates.push(callId);
        },
      }),
    );
    if (lateContext === undefined) throw new Error('the executor never called reconcile');
    lateContext.update([{ type: 'content', content: { type: 'text', text: 'late' } }] as never);
    lateContext.attachProcess?.({ pgid: 4242, startedAt: harness.clock.now() });

    expect(outcome).toMatchObject({ callId: 'c1', reconciled: 'unknown' });
    expect(updates).toEqual([]);
    expect(harness.idempotency.log.filter((entry) => entry.op === 'attachProcess')).toEqual([]);
  });
});

describe('executor post-reconcile gate applies readDenied', () => {
  it('completes the record as failed with the denial and never executes', async () => {
    const harness = makeHarness();
    const secret = path.join(harness.layout.project, 'secret.txt');
    fs.writeFileSync(secret, 'secret');
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit' });
    let executed = 0;
    const tool = makeTool('Edit', {
      kind: 'edit',
      sideEffect: 'write', subjectKind: 'path',
      subject: () => ({ kind: 'path', tool: 'Edit', paths: [secret], access: 'write' }),
      reconcile: async () => ({ outcome: 'not_applied', output: '' }),
      execute: async () => {
        executed += 1;
        return { status: 'completed', output: 'edited' };
      },
    });

    const [outcome] = await harness.executor.runBatch(
      await harness.input(await toolSetOf(tool), [call('c1', 'Edit')], {
        mode: 'bypassPermissions',
        sandboxPolicy: { ...(await minimalPolicyFor({ layout: harness.layout })), readDenied: [secret] },
      }),
    );

    expect(executed).toBe(0);
    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', result: { status: 'failed' } });
    expect(String((outcome as { result?: { output?: string } }).result?.output)).toMatch(/^Permission denied/);
    expect(harness.idempotency.records.get(KEY)).toMatchObject({ kind: 'completed', result: { result: { status: 'failed' } } });
  });
});
