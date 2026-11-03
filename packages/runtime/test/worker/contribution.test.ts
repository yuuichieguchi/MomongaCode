import { describe, expect, it } from 'vitest';
import { createMemoryPort } from '@momonga/runtime';
import type { Worker } from '@momonga/runtime';
import { within } from './deferred.ts';
import { LEASE_MS, makeEnv, textOf, unavailableEvidenceRun } from './harness.ts';
import type { Env } from './harness.ts';
import { assistantMessage, callsStep, gated, incompleteStep, refusalStep, textStep, textThenCallsStep } from './scripts.ts';

const memoryWorker = (env: Env, id: string): Worker => env.worker(id, { memories: createMemoryPort({ store: env.store, settings: env.settings, evidenceRun: unavailableEvidenceRun }) });

const saveNote = async (env: Env, text: string, callId = 'call_m_1'): Promise<string> => {
  env.gateway.script.push(callsStep([{ callId, name: 'MemorySave', args: { text, scope: 'user' } }]), textStep('Remembered.'));
  const run = env.enqueue('Remember this', { history: 'fresh' });
  await env.runOnce(memoryWorker(env, `saver-${callId}`));
  expect(env.run(run.id).status).toBe('COMPLETED');
  const saved = env.store.memories.list().find((memory) => memory.text === text);
  if (saved === undefined) throw new Error('the note was not saved');
  return saved.id;
};

const NOTE = 'launch with zorpLauncher';

describe('context.contribution at terminal', () => {
  it('records a memory named by a step and stamps contributedAt in a completed run', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const id = await saveNote(env, NOTE);
    env.clock.advance(60_000);
    env.gateway.script.push(textStep('Running zorpLauncher.'));
    const run = env.enqueue('Say hello', { history: 'fresh' });

    await env.runOnce(memoryWorker(env, 'worker-2'));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'context.contribution').map((event) => event.items)).toEqual([[{ kind: 'memory', id, contributed: true }]]);
    expect(env.store.memories.get(id)?.contributedAt).toBe(env.clock.now());
  });

  it('records an unused memory as not contributed and leaves contributedAt empty', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const id = await saveNote(env, NOTE);
    env.gateway.script.push(textStep('Hello.'));
    const run = env.enqueue('Say hello', { history: 'fresh' });

    await env.runOnce(memoryWorker(env, 'worker-2'));

    expect(env.ofType(run.id, 'context.contribution').map((event) => event.items)).toEqual([[{ kind: 'memory', id, contributed: false }]]);
    expect(env.store.memories.get(id)?.contributedAt).toBeNull();
  });

  it('gives nothing when the task already named the identifier', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const id = await saveNote(env, NOTE);
    env.gateway.script.push(textStep('Running zorpLauncher.'));
    const run = env.enqueue('Start zorpLauncher', { history: 'fresh' });

    await env.runOnce(memoryWorker(env, 'worker-2'));

    expect(env.ofType(run.id, 'context.contribution').map((event) => event.items)).toEqual([[{ kind: 'memory', id, contributed: false }]]);
  });

  it('records the event in a stopped run and does not stamp contributedAt', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const id = await saveNote(env, NOTE);
    env.gateway.script.push(incompleteStep([assistantMessage('m1', 'Running zorpLauncher.')]));
    const run = env.enqueue('Say hello', { history: 'fresh' });

    await env.runOnce(memoryWorker(env, 'worker-2'));

    expect(env.run(run.id).status).toBe('STOPPED');
    expect(env.ofType(run.id, 'context.contribution').map((event) => event.items)).toEqual([[{ kind: 'memory', id, contributed: true }]]);
    expect(env.store.memories.get(id)?.contributedAt).toBeNull();
  });

  it('records the event in a run stopped by a refusal after injection', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const id = await saveNote(env, NOTE);
    env.gateway.script.push(refusalStep('No.'));
    const run = env.enqueue('Say hello', { history: 'fresh' });

    await env.runOnce(memoryWorker(env, 'worker-2'));

    expect(env.run(run.id).status).toBe('STOPPED');
    expect(env.ofType(run.id, 'context.contribution').map((event) => event.items)).toEqual([[{ kind: 'memory', id, contributed: false }]]);
  });

  it('records the event in a failed run and does not stamp contributedAt', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const id = await saveNote(env, NOTE);
    env.gateway.script.push(incompleteStep([assistantMessage('m1', 'Running zorpLauncher.')], 'server_cut'));
    const run = env.enqueue('Say hello', { history: 'fresh' });

    await env.runOnce(memoryWorker(env, 'worker-2'));

    expect(env.run(run.id).status).toBe('FAILED');
    expect(env.ofType(run.id, 'context.contribution').map((event) => event.items)).toEqual([[{ kind: 'memory', id, contributed: true }]]);
    expect(env.store.memories.get(id)?.contributedAt).toBeNull();
  });

  it('records the event once in a run cancelled during a model step', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const id = await saveNote(env, NOTE);
    const blocked = gated(textStep('Done.'), 1);
    env.gateway.script.push(textThenCallsStep('Running zorpLauncher.', [{ callId: 'call_e', name: 'Echo', args: { value: 'x' } }]), blocked);
    const run = env.enqueue('Say hello', { history: 'fresh' });

    const running = env.runOnce(memoryWorker(env, 'worker-2'));
    await within(blocked.gate.reached.promise, 5_000, 'the second stream to start');
    env.cancel(run.id);
    blocked.gate.release.resolve();
    await within(running, 5_000, 'the worker to settle');
    if (env.run(run.id).status !== 'CANCELLED') await env.runOnce(memoryWorker(env, 'worker-3'));

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.ofType(run.id, 'context.contribution').map((event) => event.items)).toEqual([[{ kind: 'memory', id, contributed: true }]]);
    expect(env.store.memories.get(id)?.contributedAt).toBeNull();
  });

  it('records the event before the terminal status when a run is cancelled while it waits for a person', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const id = await saveNote(env, NOTE);
    env.setMode('default');
    env.gateway.script.push(textThenCallsStep('Running zorpLauncher.', [{ callId: 'call_w', name: 'MemorySave', args: { text: 'other', scope: 'user' } }]));
    const run = env.enqueue('Say hello', { history: 'fresh' });
    await env.runOnce(memoryWorker(env, 'worker-2'));
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');

    env.cancel(run.id);

    expect(env.run(run.id).status).toBe('CANCELLED');
    const events = env.events(run.id);
    const contribution = events.filter((event) => event.type === 'context.contribution');
    expect(contribution).toMatchObject([{ items: [{ kind: 'memory', id, contributed: true }] }]);
    const terminalSeq = events.find((event) => event.type === 'run.status' && event.to === 'CANCELLED')?.seq ?? 0;
    expect(contribution[0]?.seq).toBeLessThan(terminalSeq);
  });

  it('records the event once across a recovery and measures the steps of both attempts', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const id = await saveNote(env, NOTE);
    const before = env.gateway.streams.length;
    const blocked = gated(textStep('Done.'), 1);
    env.gateway.script.push(textThenCallsStep('Running zorpLauncher.', [{ callId: 'call_e', name: 'Echo', args: { value: 'x' } }]), blocked);
    const run = env.enqueue('Say hello', { history: 'fresh' });

    const abandoned = env.runOnce(memoryWorker(env, 'worker-a'));
    await within(blocked.gate.reached.promise, 5_000, 'the second stream to start');
    env.clock.advance(LEASE_MS + 1);
    const recovering = env.runOnce(memoryWorker(env, 'worker-b'));
    await within(env.gateway.nthStream(before + 2), 5_000, 'the recovery re-send');
    blocked.gate.release.resolve();
    await within(recovering, 5_000, 'the recovering worker');
    await within(abandoned, 5_000, 'the abandoned worker to stop');

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'context.contribution').map((event) => event.items)).toEqual([[{ kind: 'memory', id, contributed: true }]]);
    expect(env.store.memories.get(id)?.contributedAt).toBe(env.clock.now());
  });

  it('keeps the event a crash left in the journal, adds no second one, and still stamps contributedAt', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const id = await saveNote(env, NOTE);
    const run = env.enqueue('Say hello', { history: 'fresh' });
    env.seed(run.id, [{ type: 'context.contribution', items: [{ kind: 'memory', id, contributed: true }] }], 'crash');
    env.gateway.script.push(textStep('Hello.'));

    await env.runOnce(memoryWorker(env, 'worker-2'));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'context.contribution').map((event) => event.items)).toEqual([[{ kind: 'memory', id, contributed: true }]]);
    expect(env.store.memories.get(id)?.contributedAt).toBe(env.clock.now());
  });

  it('orders recall by contribution in the next run', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const first = await saveNote(env, 'prefers quuxBuilder', 'call_m_1');
    env.clock.advance(1);
    const second = await saveNote(env, NOTE, 'call_m_2');
    env.clock.advance(1);
    env.gateway.script.push(textStep('Running zorpLauncher.'));
    env.enqueue('Say hello', { history: 'fresh' });
    await env.runOnce(memoryWorker(env, 'worker-2'));
    env.clock.advance(1);
    const next = env.gateway.streams.length;
    env.gateway.script.push(textStep('Hello.'));
    env.enqueue('Say hello again', { history: 'fresh' });

    await env.runOnce(memoryWorker(env, 'worker-3'));

    const input = env.gateway.streams[next]?.body.input;
    const block = (Array.isArray(input) ? input : []).map(textOf).find((text) => text.includes('<recalled_memories>')) ?? '';
    expect(block.indexOf(`<memory id="${second}"`)).toBeGreaterThan(-1);
    expect(block.indexOf(`<memory id="${second}"`)).toBeLessThan(block.indexOf(`<memory id="${first}"`));
  });
});
