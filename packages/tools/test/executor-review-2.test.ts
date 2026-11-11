import { nodeFileSystem, systemRandom } from '@momonga/foundation';
import { unconfiguredNetworkOf, FAKE_LEASE, fakePolicyFilesystem, hostFilesystemOf, testProcessInspector } from '@momonga/testkit';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createToolExecutor, nodeShellHost } from '@momonga/tools';
import type { CallOutcome } from '@momonga/tools';
import { call, expectedDigestOf, makeHarness, makeTool, toolSetOf } from './harness.ts';
import type { Harness } from './harness.ts';
import { keyFor, ruleFor } from './helpers.ts';
import { momongaLayout } from '@momonga/foundation';

const KEY = keyFor('run-1', 1, 'c1');
const CAP_MS = 20;
const GRACE_MS = 20;

const boundedExecutor = (harness: Harness) =>
  createToolExecutor({
    layout: momongaLayout(harness.layout.home, process.platform, process.env),
    reap: { inspector: testProcessInspector() },
    shellHost: nodeShellHost(),
    random: systemRandom,
    files: nodeFileSystem, outboundNetwork: unconfiguredNetworkOf, fs: hostFilesystemOf(fakePolicyFilesystem()), ...FAKE_LEASE,
    idempotency: harness.idempotency.port,
    blobs: harness.blobs.port,
    clock: harness.clock,
    processMarkerDir: harness.markerDir,
    callLockDir: harness.callLockDir,
    kernelLock: harness.kernelLock,
    onWarning: () => undefined,
    reconcileCapMs: CAP_MS,
    reconcileGraceMs: GRACE_MS,
  });

const settledWithin = async <T>(promise: Promise<T>, ms: number): Promise<T | 'unsettled'> => {
  let handle: NodeJS.Timeout | undefined;
  const timeout = new Promise<'unsettled'>((resolve) => {
    handle = setTimeout(() => resolve('unsettled'), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(handle);
  }
};

describe('executor bounded reconcile', () => {
  it.each([
    ['recoverOnly', { recoverOnly: true as const }],
    ['normal recovery', {}],
  ])('reports unknown when reconcile never settles under %s', async (_label, extra) => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Stall' });
    let executed = 0;
    const tool = makeTool('Stall', {
      kind: 'edit',
      sideEffect: 'write', subjectKind: 'none',
      reconcile: () => new Promise(() => undefined),
      execute: async () => {
        executed += 1;
        return { status: 'completed', output: 'executed' };
      },
    });

    const result = await settledWithin(
      boundedExecutor(harness).runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Stall')], { mode: 'bypassPermissions', ...extra })),
      2_000,
    );

    expect(result).not.toBe('unsettled');
    const [outcome] = result as CallOutcome[];
    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', reconciled: 'unknown', result: { status: 'failed' } });
    expect(executed).toBe(0);
    expect(harness.idempotency.stateOf(KEY)).toBe('COMPLETED');
    expect(harness.idempotency.records.get(KEY)).toMatchObject({ kind: 'completed', result: { reconciled: 'unknown' } });
  });
});

describe('executor admission of a call with an existing record', () => {
  it('asks again instead of re-executing when the subject changed and reconcile reports not_applied', async () => {
    const harness = makeHarness();
    const dir = path.join(harness.layout.project, 'dir');
    const other = path.join(harness.layout.project, 'other');
    fs.mkdirSync(dir);
    fs.mkdirSync(other);
    const target = path.join(dir, 'file.txt');
    const subject = { kind: 'path' as const, tool: 'Edit', paths: [target], access: 'write' as const };
    let executed = 0;
    const tool = makeTool('Edit', {
      kind: 'edit',
      sideEffect: 'write', subjectKind: 'path',
      subject: () => subject,
      reconcile: async () => ({ outcome: 'not_applied', output: '' }),
      execute: async () => {
        executed += 1;
        return { status: 'completed', output: 'edited' };
      },
    });
    const approvedDigest = await expectedDigestOf(tool, {}, harness);
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit' });
    fs.rmSync(dir, { recursive: true });
    fs.symlinkSync(other, dir, 'dir');

    const [outcome] = await harness.executor.runBatch(
      await harness.input(await toolSetOf(tool), [call('c1', 'Edit', {}, { kind: 'allow_once', subjectDigest: approvedDigest })], { mode: 'manual' }),
    );

    expect(outcome).toMatchObject({ callId: 'c1', kind: 'needs_approval' });
    expect(executed).toBe(0);
    expect(harness.idempotency.stateOf(KEY)).toBe('PENDING');
  });

  it('reconciles a started call even though a deny rule was added after it started', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Write' });
    let reconciled = 0;
    const tool = makeTool('Write', {
      kind: 'edit',
      sideEffect: 'write', subjectKind: 'none',
      reconcile: async () => {
        reconciled += 1;
        return { outcome: 'already_applied', output: 'already marked' };
      },
    });

    const [outcome] = await harness.executor.runBatch(
      await harness.input(await toolSetOf(tool), [call('c1', 'Write')], { rules: [ruleFor(harness.layout)('deny', 'Write')] }),
    );

    expect(reconciled).toBe(1);
    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', reconciled: 'already_applied', result: { status: 'completed', output: 'already marked' } });
  });

  it('completes the record as failed with the denial when reconcile reports not_applied and a deny rule now applies', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Write' });
    let executed = 0;
    const tool = makeTool('Write', {
      kind: 'edit',
      sideEffect: 'write', subjectKind: 'none',
      reconcile: async () => ({ outcome: 'not_applied', output: '' }),
      execute: async () => {
        executed += 1;
        return { status: 'completed', output: 'marked' };
      },
    });

    const [outcome] = await harness.executor.runBatch(
      await harness.input(await toolSetOf(tool), [call('c1', 'Write')], { rules: [ruleFor(harness.layout)('deny', 'Write')] }),
    );

    expect(executed).toBe(0);
    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', result: { status: 'failed' } });
    expect(String((outcome as { result?: { output?: string } }).result?.output)).toMatch(/^Permission denied/);
    expect(harness.idempotency.stateOf(KEY)).toBe('COMPLETED');
    expect(harness.idempotency.records.get(KEY)).toMatchObject({ kind: 'completed', result: { result: { status: 'failed' } } });
  });
});
