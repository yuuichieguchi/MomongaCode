import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventPayload } from '@momonga/protocol';
import { bodyDigest, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, functionCallItem, textStep, textThenCallsStep } from './scripts.ts';

const echo = (callId: string, value: string) => ({ callId, name: 'Echo', args: { value } });

const seqOf = (events: readonly RunEvent[], predicate: (event: RunEvent) => boolean): number => {
  const found = events.find(predicate);
  if (found === undefined) throw new Error('expected event not found');
  return found.seq;
};

const expectRejected = (env: Env, runId: string, position: { step: number; attempt: number }): void => {
  const events = env.events(runId);
  expect(env.run(runId)).toMatchObject({ status: 'FAILED', error: { code: 'call_id_reused' } });
  const restarted = seqOf(events, (event) => event.type === 'model.stream.restarted' && event.step === position.step && event.attempt === position.attempt);
  const delta = seqOf(events, (event) => event.type === 'agent.message.delta' && event.step === position.step);
  const notice = seqOf(events, (event) => event.type === 'notice' && event.level === 'error' && event.seq > restarted);
  const failed = seqOf(events, (event) => event.type === 'run.status' && event.to === 'FAILED');
  expect(delta).toBeLessThan(restarted);
  expect(restarted).toBeLessThan(notice);
  expect(notice).toBeLessThan(failed);
  expect(env.ofType(runId, 'model.responded').some((event) => event.step === position.step)).toBe(false);
  expect(env.ofType(runId, 'run.status').filter((event) => event.seq > restarted).map((event) => event.to)).toEqual(['FAILED']);
  const state = env.fold(runId);
  expect(state.streaming).toBeUndefined();
  expect(state.status).toBe('FAILED');
};

describe('call-id uniqueness assertion', () => {
  it('fails the run with call_id_reused when one response repeats a call id, and executes nothing', async () => {
    const env = await makeEnv();
    env.gateway.rewriteCallIds = false;
    env.gateway.script.push(textThenCallsStep('Running both.', [echo('call_1', 'a'), echo('call_1', 'b')]));
    const run = env.enqueue('Echo twice');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expectRejected(env, run.id, { step: 1, attempt: 1 });
    expect(env.ofType(run.id, 'tool.call')).toEqual([]);
    expect(env.toolbox.executions).toEqual([]);
    expect(env.gateway.script).toEqual([]);
  });

  it('fails the run with call_id_reused when a later response reuses an id already in the history', async () => {
    const env = await makeEnv();
    env.gateway.rewriteCallIds = false;
    env.gateway.script.push(callsStep([echo('call_1', 'first')]), textThenCallsStep('Again.', [echo('call_1', 'second')]), textStep('never sent'));
    const run = env.enqueue('Echo twice');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expectRejected(env, run.id, { step: 2, attempt: 1 });
    expect(env.toolbox.executions.map((execution) => execution.input)).toEqual([{ value: 'first' }]);
    expect(env.ofType(run.id, 'tool.call').map((event) => event.callId)).toEqual(['call_1']);
    expect(env.gateway.script).toHaveLength(1);
    expect(env.fold(run.id).history.filter((entry) => entry.item.type === 'function_call')).toHaveLength(1);
  });

  it('does not trip on ids the gateway issued fresh for a repeated script id', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([echo('call_m_1', 'first')]), callsStep([echo('call_m_1', 'second')]), textStep('Done.'));
    const run = env.enqueue('Echo twice');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'tool.call').map((event) => event.callId)).toEqual(env.gateway.issuedCallIds('call_m_1'));
  });

  const USAGE = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };

  const toolCallPayload = (callId: string): RunEventPayload => ({
    type: 'tool.call',
    callId,
    providerCallId: callId,
    name: 'Echo',
    kind: 'other',
    title: 'Echo',
    rawInput: { value: 'seed' },
  });

  const completedCall = (callId: string, step: number): RunEventPayload[] => [
    { type: 'model.requested', step, attempt: 1, digest: `d${step}`, body: { model: 'fm', input: 'seed' } },
    {
      type: 'model.responded',
      step,
      attempt: 1,
      response: { status: 'completed', output: [functionCallItem(echo(callId, 'seed'))], usage: USAGE },
    },
    toolCallPayload(callId),
    { type: 'tool.started', callId, idemKey: `k-${callId}` },
    { type: 'tool.completed', callId, status: 'completed', output: 'seed' },
  ];

  it('fails the run when a response reuses an id that is only in pendingCalls', async () => {
    const env = await makeEnv();
    env.gateway.rewriteCallIds = false;
    const run = env.enqueue('Echo');
    await env.seed(run.id, [toolCallPayload('call_p'), { type: 'tool.started', callId: 'call_p', idemKey: 'k-p' }, { type: 'tool.completed', callId: 'call_p', status: 'completed', output: 'seed' }], 'release');
    const state = env.fold(run.id);
    expect(state.history.some((entry) => entry.item.type === 'function_call')).toBe(false);
    expect(Object.keys(state.pendingCalls)).toEqual(['call_p']);
    env.gateway.script.push(textThenCallsStep('Again.', [echo('call_p', 'again')]), textStep('never sent'));

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expectRejected(env, run.id, { step: 1, attempt: 1 });
    expect(env.toolbox.executions).toEqual([]);
  });

  it('fails the run when a response reuses an evicted id (also pending in 1.10e-1)', async () => {
    const env = await makeEnv();
    env.gateway.rewriteCallIds = false;
    const run = env.enqueue('Echo');
    await env.seed(run.id, [...completedCall('call_e', 1), { type: 'context.truncated', callId: 'call_e', handle: 'blob-e', kind: 'omitted' }], 'release');
    expect(env.fold(run.id).evicted).toEqual(['call_e']);
    expect(Object.keys(env.fold(run.id).pendingCalls)).toContain('call_e');
    env.gateway.script.push(textThenCallsStep('Again.', [echo('call_e', 'again')]), textStep('never sent'));

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expectRejected(env, run.id, { step: 2, attempt: 1 });
    expect(env.toolbox.executions).toEqual([]);
  });

  it('asserts on the resumed stream too, restarting once for the recovery and once for the rejection', async () => {
    const env = await makeEnv();
    env.gateway.rewriteCallIds = false;
    const run = env.enqueue('Echo');
    const body = { model: 'fm', input: [{ type: 'message', role: 'user', content: 'Echo' }], store: false, stream: true };
    await env.seed(
      run.id,
      [
        ...completedCall('call_r', 1),
        { type: 'model.requested', step: 2, attempt: 1, digest: bodyDigest(body), body },
        { type: 'agent.message.delta', step: 2, attempt: 1, itemId: 'msg_stale', text: 'stale partial' },
      ],
      'crash',
    );
    env.gateway.script.push(textThenCallsStep('Resumed.', [echo('call_r', 'again')]), textStep('never sent'));

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expectRejected(env, run.id, { step: 2, attempt: 1 });
    const events = env.events(run.id);
    const restarts = events.filter((event) => event.type === 'model.stream.restarted' && event.step === 2);
    expect(restarts).toHaveLength(2);
    const staleDelta = seqOf(events, (event) => event.type === 'agent.message.delta' && event.step === 2 && event.seq < restarts[0]!.seq);
    const resumedDelta = events.filter((event) => event.type === 'agent.message.delta' && event.step === 2 && event.seq > restarts[0]!.seq);
    expect(staleDelta).toBeLessThan(restarts[0]!.seq);
    expect(resumedDelta.length).toBeGreaterThan(0);
    expect(resumedDelta.every((event) => event.seq < restarts[1]!.seq)).toBe(true);
    expect(env.ofType(run.id, 'model.responded').some((event) => event.step === 2)).toBe(false);
  });
});
