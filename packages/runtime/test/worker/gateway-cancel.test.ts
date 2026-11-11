import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { GatewayRequestError } from '@momonga/runtime';
import { deferred } from './deferred.ts';
import { LEASE_MS, bodyDigest, capabilitiesFor, compactKey, makeEnv, modelKey } from './harness.ts';
import type { Env } from './harness.ts';
import { assistantMessage, gated, textStep } from './scripts.ts';

const untilAborted = (signal: AbortSignal | undefined): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal === undefined || signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

const recordStatusAtCancel = (env: Env, runId: string): string[] => {
  const statuses: string[] = [];
  env.gateway.cancelHook = async () => {
    statuses.push(env.run(runId).status);
  };
  return statuses;
};

const seedInFlightRequest = async (env: Env, runId: string): Promise<void> => {
  const body = { model: 'fm', input: [{ type: 'message', role: 'user', content: 'Work' }], store: false, stream: true };
  await env.seed(runId, [{ type: 'model.requested', step: 1, attempt: 1, digest: bodyDigest(body), body }], 'crash');
};

const responded = (step: number, text: string): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { status: 'completed', output: [assistantMessage(`msg_${step}`, text)], usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } },
});

describe('worker gateway cancel wiring', () => {
  it('cancels the live model key upstream before the CANCELLED transition', async () => {
    const env = await makeEnv();
    const blocked = gated(textStep('never finished', { chunks: ['partial ', 'answer'] }), 4);
    env.gateway.script.push(blocked);
    const run = await env.enqueue('Long answer');
    const statuses = recordStatusAtCancel(env, run.id);
    const running = env.runOnce(env.worker('worker-1', { cancelPollMs: 10 }));
    await env.settled(blocked.gate.reached.promise, 'the stream to start');

    await env.store.requestCancel(run.id);
    await env.settled(running, 'the worker to finish after cancel');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.gateway.cancels.map((call) => call.idempotencyKey)).toEqual([modelKey(run.id, 1, 1)]);
    expect(env.gateway.cancels[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(statuses).toEqual(['CANCELLING']);
  });

  it('cancels the live compaction key upstream when the cancel lands while compacting', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(40_000) });
    const run = await env.enqueue('Task one');
    await env.seed(
      run.id,
      [
        responded(1, 'x'.repeat(100_000)),
        { type: 'user.message', text: 'question two' },
        responded(2, 'answer two'),
        { type: 'user.message', text: 'question three' },
        responded(3, 'answer three'),
        { type: 'user.message', text: 'question four' },
      ],
      'release',
    );
    env.gateway.script.push(textStep('never sent'));
    const compacting = deferred<void>();
    env.gateway.compactHook = async (_request, signal) => {
      compacting.resolve();
      await untilAborted(signal);
      throw signal?.reason;
    };
    const statuses = recordStatusAtCancel(env, run.id);
    const running = env.runOnce(env.worker('worker-1', { cancelPollMs: 10 }));
    await env.settled(compacting.promise, 'the compaction to start');

    await env.store.requestCancel(run.id);
    await env.settled(running, 'the worker to finish after cancel');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.gateway.cancels.map((call) => call.idempotencyKey)).toEqual([compactKey(run.id, env.gateway.compacts[0]?.request)]);
    expect(statuses).toEqual(['CANCELLING']);
    expect(env.gateway.streams).toEqual([]);
  });

  it('cancels the folded in-flight model key on a CANCELLING claim', async () => {
    const env = await makeEnv();
    const run = await env.enqueue('Work');
    await seedInFlightRequest(env, run.id);
    expect((await env.cancel(run.id)).status).toBe('CANCELLING');
    const statuses = recordStatusAtCancel(env, run.id);

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.gateway.cancels.map((call) => call.idempotencyKey)).toEqual([modelKey(run.id, 1, 1)]);
    expect(statuses).toEqual(['CANCELLING']);
    expect(env.gateway.streams).toEqual([]);
  });

  it('does not cancel upstream on a CANCELLING claim with no in-flight model request', async () => {
    const env = await makeEnv();
    const run = await env.enqueue('Work');
    await env.seed(run.id, [], 'crash');
    expect((await env.cancel(run.id)).status).toBe('CANCELLING');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.gateway.cancels).toEqual([]);
  });

  it('reaches CANCELLED with a notice when the upstream cancel rejects', async () => {
    const env = await makeEnv();
    const run = await env.enqueue('Work');
    await seedInFlightRequest(env, run.id);
    await env.cancel(run.id);
    env.gateway.cancelHook = async () => {
      throw new GatewayRequestError({ status: 0, type: 'transport', code: 'gateway_unavailable', message: 'connect ENOENT', provenNotSent: true });
    };

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.gateway.cancels).toHaveLength(1);
    const notices = env.ofType(run.id, 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toContain('connect ENOENT');
  });

  it('leaves the bound of the upstream cancel to the gateway client and aborts it only with the claim', async () => {
    const env = await makeEnv();
    const run = await env.enqueue('Work');
    await seedInFlightRequest(env, run.id);
    await env.cancel(run.id);
    const abortedAtSettle: boolean[] = [];
    env.gateway.cancelHook = async (_key, signal) => {
      await new Promise<void>((resolve) => env.timers.setTimeout(resolve, 1_500));
      abortedAtSettle.push(signal?.aborted ?? true);
    };

    await env.settled(env.runOnce(env.worker()), 'the cancel to settle');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(abortedAtSettle).toEqual([false]);
    expect(env.ofType(run.id, 'notice')).toHaveLength(0);
  });

  it('does not cancel upstream after a fatal gateway failure', async () => {
    const env = await makeEnv();
    env.gateway.script.push({ events: [], error: new GatewayRequestError({ status: 401, type: 'invalid_request', code: 'authentication_failed', message: 'rejected' }) });
    const run = await env.enqueue('Work');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('FAILED');
    expect(env.gateway.cancels).toEqual([]);
  });

  it('does not cancel upstream after losing the lease', async () => {
    const env = await makeEnv();
    const blocked = gated(textStep('late answer', { chunks: ['late ', 'answer'] }), 4);
    env.gateway.script.push(blocked);
    const run = await env.enqueue('Work');
    const running = env.runOnce(env.worker('worker-a', { heartbeatMs: 10, cancelPollMs: 10 }));
    await env.settled(blocked.gate.reached.promise, 'the stream to start');

    env.clock.advance(LEASE_MS + 1);
    expect(env.store.claim('worker-thief')?.runId).toBe(run.id);
    await env.passTime(() => env.gateway.streams[0]?.signal.reason === 'lease_lost', 'the heartbeat to abort the stream for the lost lease');
    await env.store.requestCancel(run.id);
    blocked.gate.release.resolve();
    await env.settled(running, 'the first worker to stop after losing its lease');

    expect(env.gateway.cancels).toEqual([]);
    expect(env.gateway.capabilitiesCalls).toHaveLength(1);
  });
});
