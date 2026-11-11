import { describe, expect, it } from 'vitest';
import { usageOf } from '@momonga/testkit';
import { within } from './deferred.ts';
import { LEASE_MS, START_MS, makeEnv, modelKey, toolKey } from './harness.ts';
import { assistantMessage, functionCallItem, gated, requestedOffering, textStep } from './scripts.ts';

const responded = (step: number, output: unknown[]) => ({
  type: 'model.responded' as const,
  step,
  attempt: 1,
  response: { status: 'completed' as const, output, usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } },
});

describe('worker recovery (b1): crash after model.requested', () => {
  it('re-sends the recorded body under the same key and the gateway generates once', async () => {
    const env = await makeEnv();
    const blocked = gated(textStep('Recovered answer.', { usage: usageOf(80, 6) }), 4);
    env.gateway.script.push(blocked);
    const run = await env.enqueue('Work');
    const abandoned = env.runOnce(env.worker('worker-a'));
    await within(blocked.gate.reached.promise, 5_000, 'the first stream to start');
    const [firstRequest] = env.ofType(run.id, 'model.requested');
    if (firstRequest === undefined) throw new Error('expected model.requested');

    env.clock.advance(LEASE_MS + 1);
    const recovering = env.runOnce(env.worker('worker-b'));
    await within(env.gateway.nthStream(1), 5_000, 'the recovery re-send');
    blocked.gate.release.resolve();
    await within(recovering, 5_000, 'the recovering worker');
    await within(abandoned, 5_000, 'the abandoned worker to stop');

    expect(env.run(run.id).status).toBe('COMPLETED');
    const [first, second] = env.gateway.streams;
    expect(env.gateway.streams).toHaveLength(2);
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(second?.idempotencyKey).toBe(modelKey(run.id, 1, 1));
    expect(second?.body).toEqual(first?.body);
    expect(second?.body).toEqual(firstRequest.body);
    expect(env.gateway.generations.get(modelKey(run.id, 1, 1))).toBe(1);
    expect(env.ofType(run.id, 'model.requested')).toHaveLength(1);
    expect(env.ofType(run.id, 'model.responded')).toEqual([expect.objectContaining({ step: 1, attempt: 1 })]);
    expect(env.fold(run.id).inFlightModelRequest).toBeUndefined();
    expect(env.ofType(run.id, 'run.started').map((event) => event.attempt)).toEqual([1, 2]);
  });
});

describe('worker recovery (b2): crash during a tool with a PENDING record', () => {
  it('reconciles the interrupted call and never runs it again', async () => {
    const env = await makeEnv();
    const run = await env.enqueue('Mark it');
    const key = toolKey(run.id, 1, 'call_m_1');
    await env.seed(
      run.id,
      [
        requestedOffering(1, ['Mark']),
        responded(1, [functionCallItem({ callId: 'call_m_1', name: 'Mark', args: { value: 'one' } })]),
        { type: 'tool.call', callId: 'call_m_1', providerCallId: 'call_m_1', name: 'Mark', kind: 'edit', title: 'Mark one', rawInput: { value: 'one' } },
        { type: 'tool.started', callId: 'call_m_1', idemKey: key },
      ],
      'crash',
    );
    env.store.idempotency.begin(key, { expiresAt: START_MS + 86_400_000, meta: { tool: 'Mark' } });
    env.gateway.script.push(textStep('Marked.'));

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.toolbox.executions).toEqual([]);
    expect(env.toolbox.reconciles).toEqual([key]);
    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([
      expect.objectContaining({ callId: 'call_m_1', outcome: 'already_applied', output: 'already marked one' }),
    ]);
    expect(env.ofType(run.id, 'tool.started')).toHaveLength(1);
    expect(env.gateway.streams.map((stream) => stream.idempotencyKey)).toEqual([modelKey(run.id, 2)]);
  });
});

describe('worker recovery of pending calls', () => {
  it('executes a call left requested between tool.call and the batch, without re-requesting the recorded step', async () => {
    const env = await makeEnv();
    const run = await env.enqueue('Echo');
    await env.seed(
      run.id,
      [
        requestedOffering(1, ['Echo']),
        responded(1, [functionCallItem({ callId: 'call_e_1', name: 'Echo', args: { value: 'left' } })]),
        { type: 'tool.call', callId: 'call_e_1', providerCallId: 'call_e_1', name: 'Echo', kind: 'read', title: 'Echo left', rawInput: { value: 'left' } },
      ],
      'crash',
    );
    env.gateway.script.push(textStep('Echoed.'));

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.toolbox.executions.map((execution) => [execution.callId, execution.step])).toEqual([['call_e_1', 1]]);
    expect(env.ofType(run.id, 'tool.completed')).toEqual([expect.objectContaining({ callId: 'call_e_1', output: 'echo:left' })]);
    expect(env.ofType(run.id, 'tool.call')).toHaveLength(1);
    expect(env.gateway.streams.map((stream) => stream.idempotencyKey)).toEqual([modelKey(run.id, 2)]);
  });

  it('completes a run whose recorded final answer was never followed by a transition, without a model call', async () => {
    const env = await makeEnv();
    const run = await env.enqueue('Answer');
    await env.seed(run.id, [responded(1, [assistantMessage('msg_done', 'Already answered.')])], 'crash');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.streams).toEqual([]);
  });

  it('re-releases a call awaiting approval to WAITING_HUMAN, reusing the pending approval', async () => {
    const env = await makeEnv();
    const run = await env.enqueue('Write');
    const target = `${env.project}/out.txt`;
    const options = [
      { optionId: 'opt-ao', name: 'Allow once', kind: 'allow_once' as const },
      { optionId: 'opt-ro', name: 'Reject once', kind: 'reject_once' as const },
    ];
    const seeder = await env.seed(
      run.id,
      [
        responded(1, [functionCallItem({ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'x' } })]),
        { type: 'tool.call', callId: 'call_w_1', providerCallId: 'call_w_1', name: 'Write', kind: 'edit', title: `Write ${target}`, rawInput: { file_path: target, content: 'x' } },
      ],
      'hold',
    );
    const created = await env.store.requestApproval(seeder, { callId: 'call_w_1', options, event: { subjectDigest: 'a'.repeat(64), reason: 'edits require approval' } });
    if (created.kind !== 'ok') throw new Error('expected an approval');
    env.clock.advance(LEASE_MS + 1);

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    expect(env.store.approvals.listPending(run.id).map((approval) => approval.id)).toEqual([created.approval.id]);
    expect(env.ofType(run.id, 'tool.permission.requested')).toHaveLength(1);
    expect(env.gateway.streams).toEqual([]);
    expect(env.toolbox.executions).toEqual([]);
  });
});
