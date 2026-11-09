import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { groupAlive } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup } from '@momonga/testkit';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import type { Harness } from './harness.ts';
import { keyFor } from './helpers.ts';

const KEY = keyFor('run-1', 1, 'c1');
const PROCESS_TIMEOUT = { timeout: REAL_PROCESS_TEST_TIMEOUT_MS };

const groups: number[] = [];

afterEach(async () => {
  await killGroupsForCleanup(groups.splice(0));
});

const groupExists = (pgid: number): Promise<boolean> => groupAlive(pgid);

const seedEarlierAttempt = (harness: Harness): { marker: string; pgid: number } => {
  const marker = path.join(harness.markerDir, KEY);
  const fd = fs.openSync(marker, 'w', 0o600);
  let pgid: number | undefined;
  try {
    pgid = spawn('/bin/sh', ['-c', 'exec sleep 30'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', fd] }).pid;
  } finally {
    fs.closeSync(fd);
  }
  if (pgid === undefined) throw new Error('holder did not spawn');
  groups.push(pgid);
  harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit' });
  harness.idempotency.port.attachProcess(KEY, { pgid, startedAt: harness.clock.now() });
  return { marker, pgid };
};

const effectTool = (outcome: 'not_applied' | 'already_applied' = 'not_applied') => {
  const seen = { reconciles: 0, executions: 0, groupAliveAtReconcile: [] as boolean[] };
  let watched: number | undefined;
  const tool = makeTool('Edit', {
    kind: 'edit',
    sideEffect: 'write', subjectKind: 'none',
    reconcile: async () => {
      seen.reconciles += 1;
      if (watched !== undefined) seen.groupAliveAtReconcile.push(await groupExists(watched));
      return { outcome, output: `reconciled ${outcome}` };
    },
    execute: async () => {
      seen.executions += 1;
      return { status: 'completed', output: 'executed' };
    },
  });
  return {
    tool,
    seen,
    watch: (pgid: number) => {
      watched = pgid;
    },
  };
};

describe('a superseded worker starts no external effect', () => {
  it('starts nothing when the lease is already gone at the first ledger write', async () => {
    const harness = makeHarness();
    harness.idempotency.lease.held = false;
    const { tool, seen } = effectTool();
    const lostNotices: number[] = [];

    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Edit', {}, 'allow_once')], { onLeaseLost: () => void lostNotices.push(1) }),
    );

    expect(outcome).toEqual({ callId: 'c1', kind: 'deferred' });
    expect(seen.executions).toBe(0);
    expect(harness.idempotency.stateOf(KEY)).toBeUndefined();
    expect(lostNotices).toEqual([1]);
  });

  it('starts nothing when the lease is lost between tool.started and the effect', async () => {
    const harness = makeHarness();
    const { tool, seen } = effectTool();
    const lostNotices: number[] = [];

    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Edit', {}, 'allow_once')], {
        onStarted: () => {
          harness.idempotency.lease.held = false;
        },
        onLeaseLost: () => void lostNotices.push(1),
      }),
    );

    expect(outcome).toEqual({ callId: 'c1', kind: 'deferred' });
    expect(seen.executions).toBe(0);
    expect(harness.idempotency.stateOf(KEY)).toBe('PENDING');
    expect(lostNotices).toEqual([1]);
  });

  it('authorises the effect under the lease of the batch before a held lease starts it', async () => {
    const harness = makeHarness();
    const { tool, seen } = effectTool();

    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Edit', {}, 'allow_once')]));

    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'executed' } });
    expect(seen.executions).toBe(1);
    expect(harness.idempotency.fences).toEqual([{ runId: 'run-1', workerId: 'w1', leaseToken: 1 }]);
    expect(harness.idempotency.authorised).toEqual([KEY]);
  });

  it('does not reconcile or start a resumed call when the lease is gone', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit' });
    harness.idempotency.lease.held = false;
    const { tool, seen } = effectTool();

    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Edit', {}, 'allow_once')]));

    expect(outcome).toEqual({ callId: 'c1', kind: 'deferred' });
    expect(seen.reconciles).toBe(0);
    expect(seen.executions).toBe(0);
    expect(harness.idempotency.stateOf(KEY)).toBe('PENDING');
  });

  it('starts nothing after reconcile answers not_applied when the lease was lost during the reconcile', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit' });
    let executions = 0;
    const tool = makeTool('Edit', {
      kind: 'edit',
      sideEffect: 'write', subjectKind: 'none',
      reconcile: async () => {
        harness.idempotency.lease.held = false;
        return { outcome: 'not_applied', output: '' };
      },
      execute: async () => {
        executions += 1;
        return { status: 'completed', output: 'executed' };
      },
    });

    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Edit', {}, 'allow_once')]));

    expect(outcome).toEqual({ callId: 'c1', kind: 'deferred' });
    expect(executions).toBe(0);
    expect(harness.idempotency.stateOf(KEY)).toBe('PENDING');
  });

  it('does not complete a record once the lease is gone, and reports the lease loss', async () => {
    const harness = makeHarness();
    const lostNotices: number[] = [];
    const tool = makeTool('Edit', {
      kind: 'edit',
      sideEffect: 'write', subjectKind: 'none',
      execute: async () => {
        harness.idempotency.lease.held = false;
        return { status: 'completed', output: 'executed' };
      },
    });

    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(tool), [call('c1', 'Edit', {}, 'allow_once')], { onLeaseLost: () => void lostNotices.push(1) }),
    );

    expect(outcome).toEqual({ callId: 'c1', kind: 'deferred' });
    expect(harness.idempotency.stateOf(KEY)).toBe('PENDING');
    expect(lostNotices).toEqual([1]);
  });
});

describe('a taken-over call reaps the earlier attempt before it reconciles', () => {
  it('has killed the process group of the earlier attempt when reconcile runs', PROCESS_TIMEOUT, async () => {
    const harness = makeHarness();
    const { marker, pgid } = seedEarlierAttempt(harness);
    const { tool, seen, watch } = effectTool('already_applied');
    watch(pgid);

    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Edit', {}, 'allow_once')]));

    expect(outcome).toMatchObject({ kind: 'result', reconciled: 'already_applied' });
    expect(seen.groupAliveAtReconcile).toEqual([false]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('leaves the process of the current holder alone when the caller is superseded', PROCESS_TIMEOUT, async () => {
    const harness = makeHarness();
    const { pgid } = seedEarlierAttempt(harness);
    harness.idempotency.lease.held = false;
    const { tool } = effectTool();

    await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Edit', {}, 'allow_once')]));

    expect(await groupExists(pgid)).toBe(true);
  });
});
