import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SandboxPolicy } from '@momonga/sandbox';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import type { Harness } from './harness.ts';
import { keyFor } from './helpers.ts';

const KEY = keyFor('run-1', 1, 'c1');

const reconcilingTool = (outcome: 'already_applied' | 'not_applied' | 'unknown' = 'already_applied') => {
  const seen = { subjects: 0, reconciled: 0, executed: 0 };
  const tool = makeTool('Mark', {
    kind: 'edit',
    sideEffect: 'write',
    subject: () => {
      seen.subjects += 1;
      return { kind: 'path', tool: 'Mark', paths: ['/somewhere/else'], access: 'write' };
    },
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

const relativeWritablePolicy = (harness: Harness): SandboxPolicy => ({
  writableRoots: [harness.layout.project, 'relative/root'],
  writeDenied: [], writeDeniedLiterals: [],
  readDenied: [],
  network: 'deny',
});

const strayTmpDir = (harness: Harness): string => {
  const tmpDir = path.join(harness.layout.root, 'stray-tmp');
  fs.mkdirSync(tmpDir, { mode: 0o700 });
  return tmpDir;
};

describe('executor recoverOnly batches skip policy validation', () => {
  it('a recoverOnly batch reconciles a started call when the policy has a relative entry', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Mark' });
    const { tool, seen } = reconcilingTool('already_applied');

    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Mark')], { recoverOnly: true, sandboxPolicy: relativeWritablePolicy(harness) }),
    );

    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', reconciled: 'already_applied', result: { status: 'completed', output: 'reconciled already_applied' } });
    expect(seen.reconciled).toBe(1);
    expect(seen.executed).toBe(0);
    expect(harness.idempotency.stateOf(KEY)).toBe('COMPLETED');
  });

  it('a recoverOnly batch reconciles a started call when tmpDir is not one of readAllowed', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Mark' });
    const { tool, seen } = reconcilingTool('already_applied');

    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Mark')], {
        recoverOnly: true,
        tmpDir: strayTmpDir(harness),
        sandboxPolicy: { writableRoots: [harness.layout.project], writeDenied: [], writeDeniedLiterals: [], readDenied: [], readAllowed: [], network: 'deny' },
      }),
    );

    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', reconciled: 'already_applied', result: { status: 'completed' } });
    expect(seen.reconciled).toBe(1);
  });

  it('a recoverOnly batch never calls tool.subject', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Mark' });
    harness.idempotency.seed(keyFor('run-1', 1, 'c2'), 'PENDING', { tool: 'Mark' });
    const { tool, seen } = reconcilingTool('not_applied');

    const outcomes = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Mark'), call('c2', 'Mark'), call('c3', 'Mark')], { recoverOnly: true }));

    expect(seen.subjects).toBe(0);
    expect(seen.executed).toBe(0);
    expect(outcomes.map((outcome) => [outcome.callId, outcome.kind])).toEqual([
      ['c1', 'result'],
      ['c2', 'result'],
      ['c3', 'result'],
    ]);
  });

  it('a recoverOnly batch never calls a throwing tool.subject', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Mark' });
    const tool = makeTool('Mark', {
      kind: 'edit',
      sideEffect: 'write',
      subject: () => {
        throw new Error('subject must not be computed during recovery');
      },
      reconcile: async () => ({ outcome: 'already_applied', output: 'already there' }),
    });

    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Mark')], { recoverOnly: true }));

    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', reconciled: 'already_applied', result: { status: 'completed', output: 'already there' } });
  });

  it('a recoverOnly batch never builds BatchAccess', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Mark' });
    const { tool, seen } = reconcilingTool('already_applied');

    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Mark')], {
        recoverOnly: true,
        tmpDir: 'relative-session-tmp',
        sandboxPolicy: {
          writableRoots: ['relative/root'],
          writeDenied: ['relative/denied'], writeDeniedLiterals: [],
          readDenied: ['relative/read-denied'],
          readAllowed: ['relative/read-allowed'],
          network: 'deny',
        },
      }),
    );

    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', reconciled: 'already_applied' });
    expect(seen.reconciled).toBe(1);
  });

  it('a normal batch with the same policy still rejects before any tool runs or idempotency write', async () => {
    const harness = makeHarness();
    const { tool, seen } = reconcilingTool('already_applied');

    await expect(
      harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Mark')], { mode: 'bypassPermissions', sandboxPolicy: relativeWritablePolicy(harness) })),
    ).rejects.toThrow(/relative|absolute/);

    expect(seen.executed).toBe(0);
    expect(seen.subjects).toBe(0);
    expect(harness.idempotency.log).toEqual([]);
    expect(harness.started).toEqual([]);
  });
});

describe('executor recoverOnly treats UNKNOWN as already abandoned', () => {
  it('reports unknown for an UNKNOWN record without reconciling or completing it', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'UNKNOWN', { tool: 'Mark' });
    const { tool, seen } = reconcilingTool('already_applied');

    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Mark')], { recoverOnly: true }));

    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', reconciled: 'unknown', result: { status: 'failed' } });
    expect(seen.reconciled).toBe(0);
    expect(seen.executed).toBe(0);
    expect(harness.idempotency.stateOf(KEY)).toBe('UNKNOWN');
    expect(harness.idempotency.log.filter((entry) => entry.op === 'complete' || entry.op === 'begin')).toEqual([]);
  });

  it('abandon, then a lost journal append, then the next cancel claim does not reconcile and keeps the record UNKNOWN', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Mark' });
    const { tool, seen } = reconcilingTool('already_applied');

    expect(await harness.executor.abandon([{ callId: 'c1', idemKey: KEY }], { signal: new AbortController().signal })).toEqual([
      { idemKey: KEY, callId: 'c1', outcome: 'unknown' },
    ]);
    expect(harness.idempotency.stateOf(KEY)).toBe('UNKNOWN');

    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Mark')], { recoverOnly: true }));

    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', reconciled: 'unknown', result: { status: 'failed' } });
    expect(seen.reconciled).toBe(0);
    expect(harness.idempotency.stateOf(KEY)).toBe('UNKNOWN');
  });

  it('a normal batch still reconciles an UNKNOWN record', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'UNKNOWN', { tool: 'Mark' });
    const { tool, seen } = reconcilingTool('already_applied');

    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Mark', {}, 'allow_once')], { mode: 'bypassPermissions' }));

    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', reconciled: 'already_applied' });
    expect(seen.reconciled).toBe(1);
  });
});
