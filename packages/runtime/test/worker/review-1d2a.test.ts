import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { GatewayRequestError, LeaseLostError, ShutdownError } from '@momonga/runtime';
import type { Worker } from '@momonga/runtime';
import type { RuntimeStore } from '@momonga/store';
import { deferred, waitUntil, within } from './deferred.ts';
import { START_MS, bodyDigest, createdRun, makeEnv, toolKey } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, functionCallItem, gated, textStep } from './scripts.ts';
import type { ScriptStep } from './fake-gateway.ts';
import { afterMicrotasks } from '@momonga/testkit';

const FIXED_RANDOM = (): number => 0.5;

const REQUEST_BODY = { model: 'fm', input: [{ type: 'message', role: 'user', content: 'Work' }], store: false, stream: true };

const requested = (): RunEventPayload => ({ type: 'model.requested', step: 1, attempt: 1, digest: bodyDigest(REQUEST_BODY), body: REQUEST_BODY });

const gatewayClosed = (): ScriptStep => ({ events: [], error: new GatewayRequestError({ status: 503, type: 'server_error', code: 'gateway_closed', message: 'the gateway is shutting down' }) });

const startedMarkSeed = (env: Env, runId: string): void => {
  const key = toolKey(runId, 1, 'call_m_1');
  env.seed(
    runId,
    [
      {
        type: 'model.responded',
        step: 1,
        attempt: 1,
        response: { status: 'completed', output: [functionCallItem({ callId: 'call_m_1', name: 'Mark', args: { value: 'one' } })], usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } },
      },
      { type: 'tool.call', callId: 'call_m_1', providerCallId: 'call_m_1', name: 'Mark', kind: 'edit', title: 'Mark one', rawInput: { value: 'one' } },
      { type: 'tool.started', callId: 'call_m_1', idemKey: key },
    ],
    'crash',
  );
  env.store.idempotency.begin(key, { expiresAt: START_MS + 86_400_000, meta: { tool: 'Mark' } });
};

describe('WW1: bounded per-run memory', () => {
  it('keeps an entry only while a requeued run has a streak', async () => {
    const env = await makeEnv();
    env.gateway.script.push(gatewayClosed(), textStep('Recovered.'));
    const run = env.enqueue('Work');
    const worker = env.worker('worker-1', { random: FIXED_RANDOM });

    await env.runOnce(worker);
    expect(env.run(run.id).status).toBe('QUEUED');
    expect(worker.memorySize()).toBe(1);

    env.clock.set(env.run(run.id).availableAt);
    await env.runOnce(worker);
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(worker.memorySize()).toBe(0);
  });

  it('holds no entry after a run waits for a human', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: `${env.project}/out.txt`, content: 'x' } }]));
    const run = env.enqueue('Write it');
    const worker = env.worker();

    await env.runOnce(worker);

    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    expect(worker.memorySize()).toBe(0);
  });

  it('drops the entry of a requeued run cancelled through the service on an idle poll tick', async () => {
    const env = await makeEnv();
    env.gateway.script.push(gatewayClosed());
    const run = env.enqueue('Work');
    const worker = env.worker('worker-1', { random: FIXED_RANDOM, idlePollMs: 10 });
    await env.runOnce(worker);
    expect(worker.memorySize()).toBe(1);

    expect((await env.cancelToEnd(run.id)).status).toBe('CANCELLED');
    worker.start();
    await waitUntil(() => worker.memorySize() === 0, 3_000, 'the cancelled run to be forgotten');
    await within(worker.stop(), 3_000, 'the worker to stop');
  });

  it('drops the entry of a requeued run whose deadline passed on an idle poll tick', async () => {
    const env = await makeEnv();
    env.gateway.script.push(gatewayClosed());
    const run = env.enqueue('Work', { deadlineAt: START_MS + 600_000 });
    const worker = env.worker('worker-1', { random: FIXED_RANDOM, idlePollMs: 10 });
    await env.runOnce(worker);
    expect(worker.memorySize()).toBe(1);

    env.clock.set(START_MS + 600_000);
    const blocker = env.store.claim('worker-holder');
    expect(blocker?.runId).toBe(run.id);
    worker.start();
    await waitUntil(() => worker.memorySize() === 0, 3_000, 'the expired run to be forgotten');
    await within(worker.stop(), 3_000, 'the worker to stop');
  });
});

describe('WW2: CANCELLING branch guard', () => {
  it('sends no upstream cancel when the shutdown lands between the claim and drive', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Work');
    env.seed(run.id, [requested()], 'crash');
    expect(env.cancel(run.id).status).toBe('CANCELLING');
    const holder: { worker?: Worker; aborting?: Promise<void> | undefined } = {};
    const store: RuntimeStore = {
      ...env.store,
      load: (runId) => {
        holder.aborting ??= holder.worker?.abort('shutdown');
        return env.store.load(runId);
      },
    };
    holder.worker = env.worker('worker-1', { store });

    await within(env.runOnce(holder.worker), 5_000, 'the claim to settle');
    await within(holder.aborting ?? Promise.resolve(), 5_000, 'the abort to resolve');

    expect(env.gateway.cancels).toEqual([]);
    expect(env.run(run.id)).toMatchObject({ status: 'CANCELLING', leaseOwner: null });
  });
});

describe('WW3: restart detection scans from requestedSeq', () => {
  it('reads no event before requestedSeq when resuming the in-flight request', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Work');
    const padding: RunEventPayload[] = Array.from({ length: 30 }, (_unused, index) => ({ type: 'notice', level: 'info', message: `pad ${index}` }));
    env.seed(run.id, [...padding, requested(), { type: 'agent.message.delta', step: 1, attempt: 1, itemId: 'msg_partial', text: 'partial ' }], 'crash');
    const requestedSeq = env.ofType(run.id, 'model.requested')[0]?.seq ?? 0;
    expect(requestedSeq).toBeGreaterThan(30);
    const reads: { after: number; limit: number }[] = [];
    const store: RuntimeStore = {
      ...env.store,
      readRunEvents: (runId, after, limit) => {
        reads.push({ after, limit });
        return env.store.readRunEvents(runId, after, limit);
      },
    };
    env.gateway.script.push(textStep('Full answer.'));

    await env.runOnce(env.worker('worker-1', { store }));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.events(run.id).filter((event) => (event.type as string) === 'model.stream.restarted')).toHaveLength(1);
    expect(reads.filter((read) => read.limit > 1 && read.after < requestedSeq - 1)).toEqual([]);
  });
});

describe('WW4: runOnce honours stop', () => {
  it('returns idle once stop has begun', async () => {
    const env = await makeEnv();
    const blocked = gated(textStep('first'), 0);
    env.gateway.script.push(blocked, textStep('second'));
    env.enqueue('First');
    const worker = env.worker('worker-1', { idlePollMs: 10 });
    worker.start();
    await within(blocked.gate.reached.promise, 5_000, 'the first stream to start');
    const otherSession = env.store.createSession({ cwd: env.project, env: { PATH: '/usr/bin:/bin', LANG: 'C' }, permissionMode: 'default', modelAlias: 'fm' });
    const second = createdRun(env.store.createRunAndEnqueue(otherSession.id, { input: 'Second', timeoutMs: 3_600_000, limits: {}, pins: {} }));

    const stopping = worker.stop();
    const result = await env.runOnce(worker);
    blocked.gate.release.resolve();
    await within(stopping, 5_000, 'the worker to stop');

    expect(result).toBe('idle');
    expect(env.run(second.id).status).toBe('QUEUED');
  });
});

describe('WS1: quiet detached cancel recovery', () => {
  it.each([
    ['LeaseLostError', () => new LeaseLostError()],
    ['ShutdownError', () => new ShutdownError()],
  ] as const)('does not report a %s from the detached recovery after shutdown', async (_label, makeError) => {
    const env = await makeEnv();
    const run = env.enqueue('Mark it');
    startedMarkSeed(env, run.id);
    expect(env.cancel(run.id).status).toBe('CANCELLING');
    const reached = deferred<void>();
    const gate = deferred<void>();
    const thrown = deferred<void>();
    const reported: unknown[] = [];
    const worker = env.worker('worker-1', {
      onError: (error) => reported.push(error),
      tools: {
        recoveryToolSet: async () => {
          reached.resolve();
          await gate.promise;
          thrown.resolve();
          throw makeError();
        },
      },
    });
    const running = env.runOnce(worker);
    const claimEnded = running.then(() => {
      throw new Error('the claim settled before cancel recovery built its tool set');
    });
    await within(Promise.race([reached.promise, claimEnded]), 5_000, 'cancel recovery to build its tool set');

    await within(worker.abort('shutdown'), 5_000, 'the shutdown abort to resolve');
    gate.resolve();
    await thrown.promise;
    await afterMicrotasks();

    expect(reported).toEqual([]);
    expect(env.run(run.id)).toMatchObject({ status: 'CANCELLING', leaseOwner: null });
  });
});

describe('WS2: error hook and abort during stop', () => {
  it('folds the hook failure into the run notice when onError throws', async () => {
    const env = await makeEnv();
    const failing = env.enqueue('Fails to load');
    env.gateway.script.push(textStep('Hello.'));
    let thrown = false;
    const store: RuntimeStore = {
      ...env.store,
      load: (runId) => {
        if (runId === failing.id && !thrown) {
          thrown = true;
          throw new Error('load exploded');
        }
        return env.store.load(runId);
      },
    };
    let hookCalls = 0;
    const worker = env.worker('worker-1', {
      store,
      idlePollMs: 10,
      onError: () => {
        hookCalls += 1;
        throw new Error('hook broke');
      },
    });
    worker.start();
    await waitUntil(() => hookCalls === 1, 3_000, 'the hook to be called');
    await within(worker.stop(), 3_000, 'the worker to stop');

    expect(env.ofType(failing.id, 'notice').map((event) => event.message)).toEqual([
      'The worker failed on this run: load exploded (the error hook also failed: hook broke)',
    ]);
  });

  it('resolves both stop and abort when abort lands while stop is waiting', async () => {
    const env = await makeEnv();
    const blocked = gated(textStep('never finished', { chunks: ['partial ', 'answer'] }), 4);
    env.gateway.script.push(blocked);
    const run = env.enqueue('Work');
    const worker = env.worker('worker-1', { idlePollMs: 10 });
    worker.start();
    await within(blocked.gate.reached.promise, 5_000, 'the stream to start');

    const stopping = worker.stop();
    const aborting = worker.abort('shutdown');
    await within(Promise.all([stopping, aborting]), 5_000, 'stop and abort to resolve');

    expect(env.gateway.streams[0]?.signal.reason).toBe('shutdown');
    expect(env.ofType(run.id, 'model.responded')).toEqual([]);
    expect(env.ofType(run.id, 'notice')).toEqual([]);
    expect(env.run(run.id)).toMatchObject({ status: 'QUEUED', leaseOwner: null, attempts: 0 });
  });
});

describe('WS3: refundable classes count toward the streak', () => {
  it('grows the backoff and posts one notice across consecutive gateway_closed failures', async () => {
    const env = await makeEnv();
    const closed = (): ScriptStep => ({ events: [], error: new GatewayRequestError({ status: 503, type: 'server_error', code: 'gateway_closed', message: 'the gateway is shutting down' }) });
    env.gateway.script.push(closed(), closed(), closed());
    const run = env.enqueue('Work');
    const worker = env.worker('worker-1', { random: FIXED_RANDOM });
    const delays: number[] = [];

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await env.runOnce(worker);
      const current = env.run(run.id);
      expect(current).toMatchObject({ status: 'QUEUED', attempts: 0 });
      delays.push(current.availableAt - env.clock.now());
      env.clock.set(current.availableAt);
    }

    expect(delays[0]).toBeGreaterThan(0);
    expect(delays).toEqual([delays[0], 2 * (delays[0] ?? 0), 4 * (delays[0] ?? 0)]);
    expect(env.ofType(run.id, 'notice')).toHaveLength(1);
  });
});

describe('WW1: sweep after each claim', () => {
  it('drops the entry of a cancelled run after the next claim without an idle tick', async () => {
    const env = await makeEnv();
    env.gateway.script.push(gatewayClosed());
    const failed = env.enqueue('Work');
    const worker = env.worker('worker-1', { random: FIXED_RANDOM, idlePollMs: 600_000 });
    await env.runOnce(worker);
    expect(env.run(failed.id).status).toBe('QUEUED');
    expect(worker.memorySize()).toBe(1);
    expect((await env.cancelToEnd(failed.id)).status).toBe('CANCELLED');

    const enqueueElsewhere = (input: string) => {
      const session = env.store.createSession({ cwd: env.project, env: { PATH: '/usr/bin:/bin', LANG: 'C' }, permissionMode: 'default', modelAlias: 'fm' });
      return createdRun(env.store.createRunAndEnqueue(session.id, { input, timeoutMs: 3_600_000, limits: {}, pins: {} }));
    };
    const busy = enqueueElsewhere('Busy');
    const following = gated(textStep('following'), 0);
    env.gateway.script.push(textStep('busy'), following);
    enqueueElsewhere('Following');

    worker.start();
    await within(following.gate.reached.promise, 5_000, 'the following claim to start right after the busy run');

    expect(env.run(busy.id).status).toBe('COMPLETED');
    expect(worker.memorySize()).toBeLessThanOrEqual(1);
    following.gate.release.resolve();
  });
});
