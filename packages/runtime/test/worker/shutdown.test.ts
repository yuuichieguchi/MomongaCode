import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { deferred, within } from './deferred.ts';
import { START_MS, bodyDigest, makeEnv, modelKey, toolKey } from './harness.ts';
import { pinnedStart } from './cancel-fixture.ts';
import type { Env } from './harness.ts';
import { callsStep, functionCallItem, gated, requestedOffering, textStep } from './scripts.ts';

const untilAborted = (signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

const TERMINAL_STATUSES = ['COMPLETED', 'STOPPED', 'FAILED', 'CANCELLED'];

const expectYieldedWithoutTrace = (env: Env, runId: string, status: 'QUEUED' | 'CANCELLING', attemptsBefore: number, upstreamCancels = 0): void => {
  const run = env.run(runId);
  expect(run.status).toBe(status);
  expect(run.leaseOwner).toBeNull();
  expect(run.attempts).toBe(attemptsBefore);
  expect(run.availableAt).toBe(env.clock.now());
  expect(env.ofType(runId, 'notice')).toEqual([]);
  expect(env.ofType(runId, 'run.status').filter((event) => TERMINAL_STATUSES.includes(event.to))).toEqual([]);
  expect(env.gateway.cancels).toHaveLength(upstreamCancels);
};

const markCallSeed = (runId: string): RunEventPayload[] => [
  pinnedStart(),
  requestedOffering(1, ['Mark']),
  {
    type: 'model.responded',
    step: 1,
    attempt: 1,
    response: { status: 'completed', output: [functionCallItem({ callId: 'call_m_1', name: 'Mark', args: { value: 'one' } })], usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } },
  },
  { type: 'tool.call', callId: 'call_m_1', providerCallId: 'call_m_1', name: 'Mark', kind: 'edit', title: 'Mark one', rawInput: { value: 'one' } },
  { type: 'tool.started', callId: 'call_m_1', idemKey: toolKey(runId, 1, 'call_m_1') },
];

describe('worker shutdown through abort', () => {
  it('releases a runOnce claim during the model stream with a refund and no notice or terminal state', async () => {
    const env = await makeEnv();
    const blocked = gated(textStep('never finished', { chunks: ['partial ', 'answer'] }), 4);
    env.gateway.script.push(blocked);
    const run = env.enqueue('Long answer');
    const worker = env.worker();
    const running = env.runOnce(worker);
    await within(blocked.gate.reached.promise, 5_000, 'the stream to start');

    await within(worker.abort('shutdown'), 5_000, 'the shutdown abort to resolve');
    await within(running, 5_000, 'the claim to settle');

    expect(env.gateway.streams[0]?.signal.aborted).toBe(true);
    expect(env.gateway.streams[0]?.signal.reason).toBe('shutdown');
    expect(env.ofType(run.id, 'model.responded')).toEqual([]);
    expectYieldedWithoutTrace(env, run.id, 'QUEUED', 0);
  });

  it('aborts a tool batch without completing the record, and a later claim reconciles the call', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const toolStarted = deferred<void>();
    const toolSignals: AbortSignal[] = [];
    env.toolbox.hooks['Mark'] = async (_input, ctx) => {
      toolSignals.push(ctx.signal);
      toolStarted.resolve();
      await untilAborted(ctx.signal);
    };
    env.gateway.script.push(callsStep([{ callId: 'call_m_1', name: 'Mark', args: { value: 'one' } }]));
    const run = env.enqueue('Mark it');
    const worker = env.worker();
    const running = env.runOnce(worker);
    const claimEnded = running.then(() => {
      throw new Error(`the claim settled before the tool started: ${JSON.stringify(env.ofType(run.id, 'notice').map((event) => event.message))}`);
    });
    await within(Promise.race([toolStarted.promise, claimEnded]), 5_000, 'the tool to start');

    await within(worker.abort('shutdown'), 5_000, 'the shutdown abort to resolve');
    await within(running, 5_000, 'the claim to settle');

    expect(toolSignals.map((signal) => signal.aborted)).toEqual([true]);
    expect(env.fold(run.id).pendingCalls[env.gateway.callId('call_m_1')]?.status).toBe('started');
    expect(env.ofType(run.id, 'tool.completed')).toEqual([]);
    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([]);
    expectYieldedWithoutTrace(env, run.id, 'QUEUED', 0);

    env.toolbox.hooks['Mark'] = undefined;
    env.gateway.script.push(textStep('Marked.'));
    expect(await env.runOnce(env.worker('worker-2'))).toBe('yielded');

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.toolbox.reconciles).toEqual([toolKey(run.id, 1, env.gateway.callId('call_m_1'))]);
    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([expect.objectContaining({ callId: env.gateway.callId('call_m_1'), outcome: 'already_applied' })]);
  });

  it('writes nothing during cancel recovery and leaves the run CANCELLING with the lease cleared', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Mark it');
    await env.seed(run.id, markCallSeed(run.id), 'crash');
    env.store.idempotency.begin(toolKey(run.id, 1, 'call_m_1'), { expiresAt: START_MS + 86_400_000, meta: { tool: 'Mark' } });
    expect((await env.cancel(run.id)).status).toBe('CANCELLING');
    const reconcileReached = deferred<void>();
    const reconcileGate = deferred<void>();
    env.toolbox.reconcileHook = async () => {
      reconcileReached.resolve();
      await reconcileGate.promise;
    };
    const attemptsBefore = env.run(run.id).attempts;
    const worker = env.worker();
    const running = env.runOnce(worker);
    await within(reconcileReached.promise, 5_000, 'cancel recovery to reconcile');
    const seqBefore = env.run(run.id).lastSeq;

    try {
      await within(worker.abort('shutdown'), 5_000, 'the shutdown abort to resolve');
    } finally {
      reconcileGate.resolve();
    }
    await within(running, 5_000, 'the claim to settle');

    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([]);
    expect(env.events(run.id).filter((event) => event.seq > seqBefore && event.type !== 'run.status')).toEqual([]);
    expectYieldedWithoutTrace(env, run.id, 'CANCELLING', attemptsBefore);
  });

  it('releases a CANCELLING claim without a CANCELLED transition when the shutdown lands during the upstream cancel', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Work');
    const body = { model: 'fm', input: [{ type: 'message', role: 'user', content: 'Work' }], store: false, stream: true };
    await env.seed(run.id, [{ type: 'model.requested', step: 1, attempt: 1, digest: bodyDigest(body), body }], 'crash');
    expect((await env.cancel(run.id)).status).toBe('CANCELLING');
    const cancelReached = deferred<void>();
    const cancelGate = deferred<void>();
    env.gateway.cancelHook = async () => {
      cancelReached.resolve();
      await cancelGate.promise;
    };
    const attemptsBefore = env.run(run.id).attempts;
    const worker = env.worker();
    const running = env.runOnce(worker);
    const claimEnded = running.then(() => {
      throw new Error('the claim settled without calling the upstream cancel');
    });
    await within(Promise.race([cancelReached.promise, claimEnded]), 5_000, 'the upstream cancel to start');

    try {
      await within(worker.abort('shutdown'), 5_000, 'the shutdown abort to resolve');
    } finally {
      cancelGate.resolve();
    }
    await within(running, 5_000, 'the claim to settle');

    expect(env.gateway.cancels.map((call) => call.idempotencyKey)).toEqual([modelKey(run.id, 1, 1)]);
    expect(env.gateway.streams).toEqual([]);
    expectYieldedWithoutTrace(env, run.id, 'CANCELLING', attemptsBefore, 1);
  });

  it('stops claiming after a shutdown abort', async () => {
    const env = await makeEnv();
    const worker = env.worker();
    await within(worker.abort('shutdown'), 5_000, 'the shutdown abort on an idle worker');
    const run = env.enqueue('Work');
    env.gateway.script.push(textStep('never sent'));

    expect(await env.runOnce(worker)).toBe('idle');
    expect(env.run(run.id).status).toBe('QUEUED');
    expect(env.gateway.streams).toEqual([]);
  });

  it('aborts claims of the poll loop and resolves once they have released', async () => {
    const env = await makeEnv();
    const blocked = gated(textStep('never finished'), 0);
    env.gateway.script.push(blocked);
    const run = env.enqueue('Work');
    const worker = env.worker('worker-1', { idlePollMs: 10 });
    worker.start();
    await within(blocked.gate.reached.promise, 5_000, 'the stream to start');

    await within(worker.abort('shutdown'), 5_000, 'the shutdown abort to resolve');

    expectYieldedWithoutTrace(env, run.id, 'QUEUED', 0);
    expect(env.gateway.streams[0]?.signal.aborted).toBe(true);
  });
});

describe('worker graceful stop', () => {
  it('yields at the next step boundary with a refund before running the tool batch', async () => {
    const env = await makeEnv();
    const blocked = gated(callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'one' } }]), 0);
    env.gateway.script.push(blocked);
    const run = env.enqueue('Echo one');
    const worker = env.worker('worker-1', { idlePollMs: 10 });
    worker.start();
    await within(blocked.gate.reached.promise, 5_000, 'the stream to start');

    const stopping = worker.stop();
    blocked.gate.release.resolve();
    await within(stopping, 5_000, 'the graceful stop to resolve');

    expect(env.ofType(run.id, 'model.responded')).toEqual([expect.objectContaining({ step: 1, attempt: 1 })]);
    expect(env.toolbox.executions).toEqual([]);
    expect(env.gateway.streams).toHaveLength(1);
    expectYieldedWithoutTrace(env, run.id, 'QUEUED', 0);

    env.gateway.script.push(textStep('Echoed.'));
    expect(await env.runOnce(env.worker('worker-2'))).toBe('yielded');
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.toolbox.executions.map((execution) => execution.callId)).toEqual([env.gateway.callId('call_e_1')]);
  });
});
