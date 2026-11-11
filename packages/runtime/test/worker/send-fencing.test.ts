import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventPayload } from '@momonga/protocol';
import { deferred } from './deferred.ts';
import { LEASE_MS, bodyDigest, makeEnv, modelKey } from './harness.ts';
import type { Env } from './harness.ts';
import { textStep } from './scripts.ts';

const REQUEST_BODY = { model: 'fm', input: [{ type: 'message', role: 'user', content: 'Work' }], store: false, stream: true };

const requested = (): RunEventPayload => ({ type: 'model.requested', step: 1, attempt: 1, digest: bodyDigest(REQUEST_BODY), body: REQUEST_BODY });

const restartedEvents = (env: Env, runId: string): RunEvent[] => env.events(runId).filter((event) => (event.type as string) === 'model.stream.restarted');

describe('worker send fencing', () => {
  it('does not resend the in-flight request after losing the lease while preparing the claim', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Work');
    await env.seed(run.id, [requested()], 'crash');
    const reached = deferred<void>();
    const gate = deferred<void>();
    env.settings.rulesHook = async () => {
      reached.resolve();
      await gate.promise;
    };
    env.gateway.script.push(textStep('never sent by the stale worker'));
    const running = env.runOnce(env.worker('worker-stale'));
    try {
      await env.settled(reached.promise, 'the stale worker to read the rules');
      env.clock.advance(LEASE_MS + 1);
      expect(env.store.claim('worker-thief')?.runId).toBe(run.id);
    } finally {
      gate.resolve();
    }
    await env.settled(running, 'the stale worker to stop');

    expect(env.gateway.streams).toEqual([]);
    expect(env.run(run.id).leaseOwner).toBe('worker-thief');
  });
});

describe('worker model.stream.restarted', () => {
  it('appends model.stream.restarted before re-subscribing to a step that already emitted deltas', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Work');
    await env.seed(run.id, [requested(), { type: 'agent.message.delta', step: 1, attempt: 1, itemId: 'msg_partial', text: 'partial ' }], 'crash');
    env.gateway.script.push(textStep('Full answer.'));

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.streams.map((stream) => stream.idempotencyKey)).toEqual([modelKey(run.id, 1, 1)]);
    const restarted = restartedEvents(env, run.id);
    expect(restarted).toEqual([expect.objectContaining({ type: 'model.stream.restarted', step: 1, attempt: 1 })]);
    const [started] = env.ofType(run.id, 'run.started');
    const [responded] = env.ofType(run.id, 'model.responded');
    expect(restarted[0]?.seq).toBeGreaterThan(started?.seq ?? Infinity);
    expect(restarted[0]?.seq).toBeLessThan(responded?.seq ?? -Infinity);
  });

  it('does not append model.stream.restarted when the step emitted no deltas', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Work');
    await env.seed(run.id, [requested()], 'crash');
    env.gateway.script.push(textStep('Full answer.'));

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(restartedEvents(env, run.id)).toEqual([]);
  });
});
