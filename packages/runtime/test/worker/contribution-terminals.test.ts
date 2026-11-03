import { describe, expect, it } from 'vitest';
import { createMemoryPort } from '@momonga/runtime';
import type { Worker } from '@momonga/runtime';
import { makeEnv, unavailableEvidenceRun } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep, textThenCallsStep } from './scripts.ts';

const memoryWorker = (env: Env, id: string): Worker => env.worker(id, { memories: createMemoryPort({ store: env.store, settings: env.settings, evidenceRun: unavailableEvidenceRun }) });

const NOTE = 'launch with zorpLauncher';

const saveNote = async (env: Env): Promise<string> => {
  env.gateway.script.push(callsStep([{ callId: 'call_m_1', name: 'MemorySave', args: { text: NOTE, scope: 'user' } }]), textStep('Remembered.'));
  env.enqueue('Remember this', { history: 'fresh' });
  await env.runOnce(memoryWorker(env, 'saver'));
  const saved = env.store.memories.list().find((memory) => memory.text === NOTE);
  if (saved === undefined) throw new Error('the note was not saved');
  return saved.id;
};

describe('context.contribution on the terminals the worker does not reach', () => {
  it('records the event before the status when an approval timeout stops the run', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const id = await saveNote(env);
    env.setMode('default');
    env.gateway.script.push(textThenCallsStep('Running zorpLauncher.', [{ callId: 'call_w', name: 'MemorySave', args: { text: 'other', scope: 'user' } }]));
    const run = env.enqueue('Say hello', { history: 'fresh' });
    await env.runOnce(memoryWorker(env, 'worker-2'));
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    const [approval] = env.store.pendingApprovalViews(run.id);
    if (approval === undefined) throw new Error('the run asked for no approval');

    expect(env.store.expireApprovals(approval.expiresAt)).toEqual([run.id]);

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'approval_timeout' });
    const events = env.events(run.id);
    const contribution = events.filter((event) => event.type === 'context.contribution');
    expect(contribution).toMatchObject([{ items: [{ kind: 'memory', id, contributed: true }] }]);
    const terminalSeq = events.find((event) => event.type === 'run.status' && event.to === 'STOPPED')?.seq ?? 0;
    expect(contribution[0]?.seq).toBeLessThan(terminalSeq);
    expect(env.store.memories.get(id)?.contributedAt).toBeNull();
  });

  it('records no event for a run that was cancelled in the queue, because nothing was injected', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const id = await saveNote(env);
    const run = env.enqueue('Say hello', { history: 'fresh' });

    env.cancel(run.id);

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.ofType(run.id, 'context.contribution')).toEqual([]);
    expect(env.store.memories.get(id)?.contributedAt).toBeNull();
  });

  it('records no event for a run that was stopped in the queue by its deadline', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    await saveNote(env);
    const run = env.enqueue('Say hello', { history: 'fresh' });

    expect(env.store.expireApprovals(env.run(run.id).deadlineAt)).toEqual([run.id]);

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout' });
    expect(env.ofType(run.id, 'context.contribution')).toEqual([]);
  });
});
