import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { START_MS, makeEnv, toolKey } from './harness.ts';
import { pinnedStart } from './cancel-fixture.ts';
import { assistantMessage, functionCallItem, incompleteStep, requestedOffering, textStep } from './scripts.ts';

const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };

const responded = (step: number, output: unknown[], incomplete?: string): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response:
    incomplete === undefined
      ? { status: 'completed', output, usage: USAGE }
      : { status: 'incomplete', incompleteReason: incomplete, output, usage: USAGE },
});

const echoCall = (callId: string) => functionCallItem({ callId, name: 'Echo', args: { value: 'same' } });

describe('worker recovery replays the post-response decision of a recorded step', () => {
  it('stops with loop and executes nothing when the recorded step repeats the previous one', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Loop', { limits: { loopThreshold: 2 } });
    env.seed(
      run.id,
      [
        responded(1, [echoCall('call_1')]),
        { type: 'tool.call', callId: 'call_1', providerCallId: 'call_1', name: 'Echo', kind: 'read', title: 'Echo same', rawInput: { value: 'same' } },
        { type: 'tool.completed', callId: 'call_1', status: 'completed', output: 'echo:same' },
        responded(2, [echoCall('call_2')]),
      ],
      'crash',
    );

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'loop' });
    expect(env.toolbox.executions).toEqual([]);
    expect(env.ofType(run.id, 'tool.completed').map((event) => event.callId)).toEqual(['call_1']);
    expect(env.gateway.streams).toEqual([]);
  });

  it('stops with max_tokens without a model call when an incomplete response held only reasoning', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Think');
    env.seed(run.id, [responded(1, [{ type: 'reasoning', id: 'rs_1', summary: [] }], 'max_output_tokens')], 'crash');

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'max_tokens' });
    expect(env.gateway.streams).toEqual([]);
  });

  it('stops with refusal and executes nothing when the recorded output refused and also called a tool', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Refuse');
    env.seed(
      run.id,
      [
        responded(1, [
          { type: 'message', id: 'msg_refused', status: 'completed', role: 'assistant', content: [{ type: 'refusal', refusal: 'I will not.' }] },
          echoCall('call_r_1'),
        ]),
      ],
      'crash',
    );

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'refusal' });
    expect(env.toolbox.executions).toEqual([]);
    expect(env.ofType(run.id, 'tool.started')).toEqual([]);
    expect(env.gateway.streams).toEqual([]);
  });

  it('completes without a model call when the recorded output was empty', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Nothing');
    env.seed(run.id, [responded(1, [])], 'crash');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.streams).toEqual([]);
  });

  it('fails with incomplete_response when the recorded incomplete reason is unknown', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Mystery');
    env.seed(run.id, [responded(1, [assistantMessage('msg_m', 'partial')], 'mystery_reason')], 'crash');

    await env.runOnce(env.worker());

    const current = env.run(run.id);
    expect(current.status).toBe('FAILED');
    expect(current.error?.code).toBe('incomplete_response');
    expect(current.error?.message).toContain('mystery_reason');
    expect(env.gateway.streams).toEqual([]);
  });
});

describe('worker live handling of an unknown incomplete reason', () => {
  it('fails with incomplete_response after one model call and does not requeue', async () => {
    const env = await makeEnv();
    env.gateway.script.push(incompleteStep([assistantMessage('msg_p', 'partial')], 'mystery_reason'), textStep('never sent'));
    const run = env.enqueue('Mystery');

    await env.runOnce(env.worker());

    const current = env.run(run.id);
    expect(current.status).toBe('FAILED');
    expect(current.error?.code).toBe('incomplete_response');
    expect(current.error?.message).toContain('mystery_reason');
    expect(current.attempts).toBe(1);
    expect(env.gateway.streams).toHaveLength(1);
    expect(env.ofType(run.id, 'model.responded')).toHaveLength(1);
    expect(await env.runOnce(env.worker('worker-2'))).toBe('idle');
  });
});

describe('worker cancel recovery past the run deadline', () => {
  it('reconciles a started call even though the deadline has passed, then cancels', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Mark it', { deadlineAt: START_MS + 10 });
    const key = toolKey(run.id, 1, 'call_m_1');
    env.seed(
      run.id,
      [
        pinnedStart(),
        requestedOffering(1, ['Mark']),
        responded(1, [functionCallItem({ callId: 'call_m_1', name: 'Mark', args: { value: 'one' } })]),
        { type: 'tool.call', callId: 'call_m_1', providerCallId: 'call_m_1', name: 'Mark', kind: 'edit', title: 'Mark one', rawInput: { value: 'one' } },
        { type: 'tool.started', callId: 'call_m_1', idemKey: key },
      ],
      'crash',
    );
    env.store.idempotency.begin(key, { expiresAt: START_MS + 86_400_000, meta: { tool: 'Mark' } });
    expect(env.cancel(run.id).status).toBe('CANCELLING');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.toolbox.reconciles).toEqual([key]);
    expect(env.toolbox.executions).toEqual([]);
    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([expect.objectContaining({ callId: 'call_m_1', outcome: 'already_applied' })]);
    expect(env.gateway.streams).toEqual([]);
  });
});
