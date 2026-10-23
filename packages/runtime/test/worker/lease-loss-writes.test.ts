import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deferred, within } from './deferred.ts';
import { LEASE_MS, makeEnv, toolKey } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep } from './scripts.ts';

const startWait = async (env: Env) => {
  env.gateway.script.push(callsStep([{ callId: 'call_wait_1', name: 'Wait', args: { value: 'forever' } }]));
  const run = env.enqueue('Wait for a long time');
  const running = env.runOnce(env.worker('worker-a', { heartbeatMs: 10 }));
  await within(env.toolbox.waitStarted.promise, 5_000, 'the long tool to start');
  return { run, running, key: toolKey(run.id, 1, 'call_wait_1') };
};

describe('worker lease loss during a long tool', () => {
  it('aborts the tool, leaves its record PENDING for the successor and writes no event', async () => {
    const env = await makeEnv();
    const { run, running, key } = await startWait(env);

    env.clock.advance(LEASE_MS + 1);
    expect(env.store.claim('worker-thief')?.runId).toBe(run.id);
    const stolenAtSeq = env.run(run.id).lastSeq;
    await within(running, 5_000, 'the first worker to stop after losing its lease');

    expect(env.toolbox.waitSignals.map((signal) => signal.aborted)).toEqual([true]);
    expect(env.store.idempotency.get(key)?.s).toBe('PENDING');
    expect(env.run(run.id)).toMatchObject({ status: 'RUNNING', leaseOwner: 'worker-thief', lastSeq: stolenAtSeq });
  });

  it('settles quietly and keeps the record the successor completed', async () => {
    const env = await makeEnv();
    const { run, running, key } = await startWait(env);
    const successorOutcome = { callId: 'call_wait_1', kind: 'result', result: { status: 'completed', output: 'successor result' } };

    env.clock.advance(LEASE_MS + 1);
    expect(env.store.claim('worker-thief')?.runId).toBe(run.id);
    env.store.idempotency.complete(key, successorOutcome);
    const stolenAtSeq = env.run(run.id).lastSeq;
    await expect(within(running, 5_000, 'the first worker to stop after losing its lease')).resolves.toBe('yielded');

    expect(env.store.idempotency.get(key)).toEqual({ s: 'COMPLETED', result: successorOutcome });
    expect(env.run(run.id).lastSeq).toBe(stolenAtSeq);
  });
});

describe('worker lease fencing of approval writes', () => {
  it('does not persist an allow_always rule after the lease was lost', async () => {
    const env = await makeEnv();
    const target = path.join(env.project, 'out.txt');
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'approved' } }]));
    const run = env.enqueue('Write the file');
    await env.runOnce(env.worker('worker-1'));
    env.resolveApproval(run.id, 'allow_always');
    const gate = deferred<void>();
    const reached = deferred<void>();
    const firstRead = env.settings.ruleReads + 1;
    env.settings.rulesHook = async (read) => {
      if (read !== firstRead) return;
      reached.resolve();
      await gate.promise;
    };

    const running = env.runOnce(env.worker('worker-2'));
    await within(reached.promise, 5_000, 'worker-2 to read the rules');
    env.clock.advance(LEASE_MS + 1);
    expect(env.store.claim('worker-thief')?.runId).toBe(run.id);
    const stolenAtSeq = env.run(run.id).lastSeq;
    gate.resolve();
    await within(running, 5_000, 'worker-2 to stop after losing its lease');

    expect(env.settings.appended).toEqual([]);
    expect(env.toolbox.executions).toEqual([]);
    expect(env.run(run.id).lastSeq).toBe(stolenAtSeq);
  });

  it('creates no approval when the lease was lost before the permission request', async () => {
    const env = await makeEnv();
    const target = path.join(env.project, 'out.txt');
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'x' } }]));
    const gate = deferred<void>();
    const reached = deferred<void>();
    env.settings.rulesHook = async (read) => {
      if (read !== 2) return;
      reached.resolve();
      await gate.promise;
    };
    const run = env.enqueue('Write the file');

    const running = env.runOnce(env.worker('worker-1'));
    await within(reached.promise, 5_000, 'the batch to read the rules');
    env.clock.advance(LEASE_MS + 1);
    expect(env.store.claim('worker-thief')?.runId).toBe(run.id);
    const stolenAtSeq = env.run(run.id).lastSeq;
    gate.resolve();
    await within(running, 5_000, 'worker-1 to stop after losing its lease');

    expect(env.store.approvals.listPending(run.id)).toEqual([]);
    expect(env.ofType(run.id, 'tool.permission.requested')).toEqual([]);
    expect(env.run(run.id).lastSeq).toBe(stolenAtSeq);
  });
});
