import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { deferred } from './deferred.ts';
import { START_MS, makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import { waitFor } from '@momonga/testkit';

describe('worker approval wait', () => {
  it('gives the approval no expiry of its own, so the run deadline ends the wait', async () => {
    const env = await makeEnv();
    const deadlineAt = START_MS + 60_000;
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: `${env.project}/out.txt`, content: 'x' } }]));
    const run = await env.enqueue('Write the file', { deadlineAt });

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    const [approval] = env.store.approvals.listPending(run.id);
    expect(approval).toBeDefined();
    expect(approval).not.toHaveProperty('expiresAt');
    expect(await env.store.expireApprovals(deadlineAt - 1, (error: unknown) => { throw error; })).toEqual([]);
    expect(await env.store.expireApprovals(deadlineAt, (error: unknown) => { throw error; })).toEqual([run.id]);
    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout' });
  });
});

describe('worker approvals for a whole batch', () => {
  it('asks for every read-only call that needs approval, in call order, and requeues only after the last resolution', async () => {
    const env = await makeEnv();
    env.settings.extraRules.push({ effect: 'ask', rule: 'UpdatePlan' });
    env.gateway.script.push(
      callsStep([
        { callId: 'call_p_1', name: 'UpdatePlan', args: { step: 'first' } },
        { callId: 'call_p_2', name: 'UpdatePlan', args: { step: 'second' } },
      ]),
      textStep('Both planned.'),
    );
    const run = await env.enqueue('Plan twice');

    expect(await env.runOnce(env.worker('worker-1'))).toBe('yielded');

    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    const requests = env.ofType(run.id, 'tool.permission.requested');
    expect(requests.map((request) => request.callId)).toEqual([env.gateway.callId('call_p_1'), env.gateway.callId('call_p_2')]);
    expect(env.store.approvals.listPending(run.id).map((approval) => approval.callId)).toEqual([env.gateway.callId('call_p_1'), env.gateway.callId('call_p_2')]);
    expect(env.toolbox.executions).toEqual([]);
    const [first, second] = requests;
    if (first === undefined || second === undefined) throw new Error('expected two permission requests');

    await env.resolveApproval(run.id, 'allow_once', first.approvalId);
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    expect(await env.runOnce(env.worker('worker-2'))).toBe('idle');

    await env.resolveApproval(run.id, 'allow_once', second.approvalId);
    expect(env.run(run.id).status).toBe('QUEUED');

    expect(await env.runOnce(env.worker('worker-3'))).toBe('yielded');
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.toolbox.executions.map((execution) => execution.input['step']).sort()).toEqual(['first', 'second']);
  });
});

describe('worker wake hook', () => {
  it('claims a new run as soon as the wake hook fires instead of waiting out the idle poll', async () => {
    const env = await makeEnv();
    const listeners = new Set<() => void>();
    const wake = {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const idle = deferred<void>();
    const store: RuntimeStore = {
      ...env.store,
      claim: (workerId) => {
        const claim = env.store.claim(workerId);
        if (claim === null) idle.resolve();
        return claim;
      },
    };
    const worker = env.worker('worker-1', { store, idlePollMs: 60_000, wake });
    worker.start();
    await env.settled(idle.promise, 'the worker to find no run');
    await waitFor(() => listeners.size === 1, { description: 'the worker to register its wake listener' });
    expect(listeners.size).toBe(1);

    env.gateway.script.push(textStep('Hello.'));
    const run = await env.enqueue('Say hello');
    for (const listener of [...listeners]) listener();

    await env.passTime(() => env.run(run.id).status === 'COMPLETED', 'the woken worker to complete the run');
    await env.settled(worker.stop(), 'the worker to stop');
    expect(listeners.size).toBe(0);
  });
});
