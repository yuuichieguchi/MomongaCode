import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createToolExecutor } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import type { Harness } from './harness.ts';
import { keyFor, sandboxPolicyFor } from './helpers.ts';

const KEY = keyFor('run-1', 1, 'c1');

const boundedExecutor = (harness: Harness, capMs: number, graceMs: number) =>
  createToolExecutor({
    idempotency: harness.idempotency.port,
    blobs: harness.blobs.port,
    clock: harness.clock,
    processMarkerDir: harness.markerDir,
    onWarning: () => undefined,
    reconcileCapMs: capMs,
    reconcileGraceMs: graceMs,
  });

const after = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
      sideEffect: 'write',
      execute: async (_input, ctx) => {
        executed.push(ctx.callId);
        return { status: 'completed', output: 'marked' };
      },
    });

    const outcomes = await harness.executor.runBatch(
      harness.input(await toolSetOf(read, mark), [call('c1', 'Read'), call('c2', 'Mark')], { mode: 'default' }),
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
    const tool = makeTool('Mark', {
      kind: 'edit',
      sideEffect: 'write',
      reconcile: async () => {
        await after(60);
        return { outcome: 'not_applied', output: '' };
      },
      execute: async () => {
        executed += 1;
        return { status: 'completed', output: 'executed' };
      },
    });

    const [outcome] = await boundedExecutor(harness, 20, 1_000).runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Mark')], { mode: 'bypassPermissions' }),
    );

    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', reconciled: 'unknown', result: { status: 'failed' } });
    expect(executed).toBe(0);
    expect(harness.idempotency.records.get(KEY)).toMatchObject({ kind: 'completed', result: { reconciled: 'unknown' } });
  });
});

describe('executor closes the tool context of an abandoned reconcile', () => {
  it('drops update and attachProcess calls made after the executor gave up', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Mark' });
    let lateDone!: () => void;
    const late = new Promise<void>((resolve) => {
      lateDone = resolve;
    });
    const updates: string[] = [];
    const tool = makeTool('Mark', {
      kind: 'edit',
      sideEffect: 'write',
      reconcile: (_input, _record, ctx) =>
        new Promise(() => {
          setTimeout(() => {
            ctx.update([{ type: 'content', content: { type: 'text', text: 'late' } }] as never);
            ctx.attachProcess?.({ pgid: 4242, startedAt: harness.clock.now() });
            lateDone();
          }, 100);
        }),
    });

    const [outcome] = await boundedExecutor(harness, 20, 20).runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Mark')], {
        mode: 'bypassPermissions',
        onUpdate: (callId) => {
          updates.push(callId);
        },
      }),
    );
    await late;

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
      sideEffect: 'write',
      subject: () => ({ kind: 'path', tool: 'Edit', paths: [secret], access: 'write' }),
      reconcile: async () => ({ outcome: 'not_applied', output: '' }),
      execute: async () => {
        executed += 1;
        return { status: 'completed', output: 'edited' };
      },
    });

    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Edit')], {
        mode: 'bypassPermissions',
        sandboxPolicy: { ...sandboxPolicyFor(harness.layout), readDenied: [secret] },
      }),
    );

    expect(executed).toBe(0);
    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', result: { status: 'failed' } });
    expect(String((outcome as { result?: { output?: string } }).result?.output)).toMatch(/^Permission denied/);
    expect(harness.idempotency.records.get(KEY)).toMatchObject({ kind: 'completed', result: { result: { status: 'failed' } } });
  });
});
