import { describe, expect, it } from 'vitest';
import { within } from './deferred.ts';
import { makeEnv } from './harness.ts';
import { callsStep, gated, textStep } from './scripts.ts';

const CANCEL_BUDGET_MS = 3_000;

describe('worker cancel', () => {
  it('cancels during the model stream within 3 s and makes no further gateway call', async () => {
    const env = await makeEnv();
    const blocked = gated(textStep('never finished', { chunks: ['partial ', 'answer'] }), 4);
    env.gateway.script.push(blocked, textStep('never sent'));
    const run = env.enqueue('Long answer');
    const running = env.runOnce(env.worker());
    await within(blocked.gate.reached.promise, 5_000, 'the stream to start');

    const requestedAt = Date.now();
    env.store.requestCancel(run.id);
    await within(running, CANCEL_BUDGET_MS + 2_000, 'the worker to finish after cancel');
    const elapsed = Date.now() - requestedAt;

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(elapsed).toBeLessThan(CANCEL_BUDGET_MS);
    expect(env.gateway.streams).toHaveLength(1);
    expect(env.gateway.streams[0]?.signal.aborted).toBe(true);
    expect(env.ofType(run.id, 'run.status').at(-1)).toMatchObject({ from: 'CANCELLING', to: 'CANCELLED' });
    expect(env.ofType(run.id, 'model.responded')).toEqual([]);
    blocked.gate.release.resolve();
    expect(env.gateway.streams).toHaveLength(1);
  });

  it('cancels during a long tool honoring its signal within 3 s and finalizes the call', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_wait_1', name: 'Wait', args: { value: 'forever' } }]), textStep('never sent'));
    const run = env.enqueue('Wait for a long time');
    const running = env.runOnce(env.worker());
    await within(env.toolbox.waitStarted.promise, 5_000, 'the long tool to start');

    const requestedAt = Date.now();
    env.store.requestCancel(run.id);
    await within(running, CANCEL_BUDGET_MS + 2_000, 'the worker to finish after cancel');
    const elapsed = Date.now() - requestedAt;

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(elapsed).toBeLessThan(CANCEL_BUDGET_MS);
    expect(env.toolbox.waitSignals.map((signal) => signal.aborted)).toEqual([true]);
    expect(env.gateway.streams).toHaveLength(1);
    const call = env.fold(run.id).pendingCalls[env.gateway.callId('call_wait_1')];
    expect(['completed', 'reconciled']).toContain(call?.status);
  });

  it('takes the cancel path without a model call when a crashed run was left CANCELLING', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Work');
    env.seed(run.id, [], 'crash');
    expect(env.cancel(run.id).status).toBe('CANCELLING');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.gateway.streams).toEqual([]);
    expect(env.ofType(run.id, 'run.status').at(-1)).toMatchObject({ from: 'CANCELLING', to: 'CANCELLED' });
  });
});
