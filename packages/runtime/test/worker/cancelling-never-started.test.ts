import { describe, expect, it } from 'vitest';
import { makeEnv, typesOf } from './harness.ts';
import type { Env } from './harness.ts';
import { MEASURED_ITEM, inertTimers, preparerFake } from './preparer-fake.ts';
import { callsStep, textStep } from './scripts.ts';

const envWithPreparer = async () => {
  const fake = preparerFake();
  const env = await makeEnv({ preparer: fake.preparer });
  fake.bind(env.store, env.dbPath);
  return { env, fake };
};

const sweeperOf = async (env: Env, errors: unknown[] = []) => {
  const { startTerminalSweeper } = await import('../../src/service/terminal-sweeper.ts');
  return startTerminalSweeper({
    store: env.store,
    timers: inertTimers,
    intervalMs: 1000,
    cancelUpstream: async () => undefined,
    releaseStopped: async () => undefined,
    onError: (error: unknown) => void errors.push(error),
  });
};

const waitingHumanRun = async (env: Env) => {
  env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: `${env.project}/out.txt`, content: 'x' } }]));
  const run = env.enqueue('Write the file');
  expect(await env.runOnce(env.worker('worker-1'))).toBe('yielded');
  expect(env.run(run.id).status).toBe('WAITING_HUMAN');
  expect(env.store.approvals.listPending(run.id)).toHaveLength(1);
  expect(Object.values(env.fold(run.id).pendingCalls).map((call) => call.status)).toEqual(['awaiting_approval']);
  return run;
};

describe('a run cancelled before any worker held it is the sweeper\'s to finish (O13 b3)', () => {
  it('a QUEUED run cancelled is CANCELLING, is not claimable at once or ever, and no worker takes it', async () => {
    const { env } = await envWithPreparer();
    env.gateway.script.push(textStep('never sent'));
    const run = env.enqueue('Work');

    expect(await env.cancel(run.id)).toMatchObject({ status: 'CANCELLING', cancelOrigin: 'QUEUED' });

    expect(env.store.claim('worker-1')).toBeNull();
    expect(await env.runOnce(env.worker('worker-2'))).toBe('idle');
    expect(env.run(run.id)).toMatchObject({ status: 'CANCELLING', leaseOwner: null });
    expect(env.gateway.streams).toHaveLength(0);
  });

  it('the sweeper finishes a QUEUED cancel as CANCELLED without a model call, its contribution before the status', async () => {
    const { env, fake } = await envWithPreparer();
    env.gateway.script.push(textStep('never sent'));
    const run = env.enqueue('Work');
    await env.cancel(run.id);
    const errors: unknown[] = [];

    await (await sweeperOf(env, errors)).sweep();

    expect(env.run(run.id)).toMatchObject({ status: 'CANCELLED', leaseOwner: null, cancelOrigin: null });
    expect(env.gateway.streams).toHaveLength(0);
    const types = typesOf(env.events(run.id));
    expect(types.slice(-2)).toEqual(['context.contribution', 'run.status']);
    expect(types).not.toContain('model.requested');
    expect(env.ofType(run.id, 'context.contribution').at(-1)?.items).toEqual([MEASURED_ITEM]);
    expect(fake.requests).toEqual([{ runId: run.id, leading: [] }]);
    expect(errors).toEqual([]);
  });

  it('requestCancel on a WAITING_HUMAN run with a pending approval answers CANCELLING and withdraws the approval', async () => {
    const { env, fake } = await envWithPreparer();
    const run = await waitingHumanRun(env);

    expect(await env.cancel(run.id)).toMatchObject({ status: 'CANCELLING', cancelOrigin: 'WAITING_HUMAN' });

    expect(env.store.approvals.listPending(run.id)).toEqual([]);
    expect(env.ofType(run.id, 'tool.permission.cancelled').at(-1)).toMatchObject({ reason: 'withdrawn' });
    expect(env.store.claim('worker-2')).toBeNull();
    expect(fake.requests).toEqual([]);
  });

  it('the sweeper finishes a WAITING_HUMAN cancel as CANCELLED, executing no call and starting no model call', async () => {
    const { env } = await envWithPreparer();
    const run = await waitingHumanRun(env);
    const streamsBefore = env.gateway.streams.length;
    await env.cancel(run.id);

    await (await sweeperOf(env)).sweep();

    expect(env.run(run.id)).toMatchObject({ status: 'CANCELLED', leaseOwner: null });
    expect(env.toolbox.executions).toEqual([]);
    expect(env.gateway.streams).toHaveLength(streamsBefore);
    expect(env.store.approvals.listPending(run.id)).toEqual([]);
    expect(await env.runOnce(env.worker('worker-2'))).toBe('idle');
  });
});
