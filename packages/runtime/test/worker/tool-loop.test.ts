import { describe, expect, it } from 'vitest';
import { usageOf } from '@momonga/testkit';
import { deferred } from './deferred.ts';
import { makeEnv, modelKey } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

describe('worker tool loop', () => {
  it('runs read-only calls of one step together, then sends their outputs in the next step', async () => {
    const env = await makeEnv();
    const bothStarted = deferred<void>();
    let started = 0;
    env.toolbox.hooks['Echo'] = async () => {
      started += 1;
      if (started === 2) bothStarted.resolve();
      await env.settled(bothStarted.promise, 'both read-only calls to run concurrently');
    };
    env.gateway.script.push(
      callsStep(
        [
          { callId: 'call_r_1', name: 'Echo', args: { value: 'a' } },
          { callId: 'call_r_2', name: 'Echo', args: { value: 'b' } },
        ],
        usageOf(100, 10),
      ),
      textStep('All done.', { usage: usageOf(150, 5) }),
    );
    const run = env.enqueue('Echo two things');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.streams.map((stream) => stream.idempotencyKey)).toEqual([modelKey(run.id, 1), modelKey(run.id, 2)]);

    const toolEvents = env.events(run.id).filter((event) => event.type.startsWith('tool.') && event.type !== 'tool.offered');
    const position = (type: string, callId: string): number =>
      toolEvents.findIndex((event) => event.type === type && 'callId' in event && event.callId === callId);
    expect(toolEvents.slice(0, 2).map((event) => event.type)).toEqual(['tool.call', 'tool.call']);
    for (const callId of [env.gateway.callId('call_r_1'), env.gateway.callId('call_r_2')]) {
      expect(position('tool.call', callId)).toBeLessThan(position('tool.started', callId));
      expect(position('tool.started', callId)).toBeLessThan(position('tool.completed', callId));
    }

    const calls = env.ofType(run.id, 'tool.call');
    expect(calls[0]).toMatchObject({ callId: env.gateway.callId('call_r_1'), providerCallId: env.gateway.callId('call_r_1'), name: 'Echo', kind: 'read', title: 'Echo a', rawInput: { value: 'a' } });
    expect(calls[1]).toMatchObject({ callId: env.gateway.callId('call_r_2'), providerCallId: env.gateway.callId('call_r_2'), name: 'Echo', kind: 'read', title: 'Echo b', rawInput: { value: 'b' } });

    const completed = env.ofType(run.id, 'tool.completed');
    expect(completed.map((event) => [event.callId, event.status, event.output]).sort()).toEqual([
      [env.gateway.callId('call_r_1'), 'completed', 'echo:a'],
      [env.gateway.callId('call_r_2'), 'completed', 'echo:b'],
    ]);
    const startedEvents = env.ofType(run.id, 'tool.started');
    expect(startedEvents.map((event) => event.idemKey).every((key) => /^[0-9a-f]{64}$/.test(key))).toBe(true);

    const lastToolSeq = Math.max(...toolEvents.map((event) => event.seq));
    const secondRequest = env.ofType(run.id, 'model.requested')[1];
    expect(secondRequest?.step).toBe(2);
    expect(secondRequest?.seq).toBeGreaterThan(lastToolSeq);

    const input = env.gateway.streams[1]?.body.input;
    if (!Array.isArray(input)) throw new Error('expected an input array');
    const outputs = input.filter((item) => item.type === 'function_call_output');
    expect(outputs).toEqual([
      expect.objectContaining({ call_id: env.gateway.callId('call_r_1'), output: 'echo:a' }),
      expect.objectContaining({ call_id: env.gateway.callId('call_r_2'), output: 'echo:b' }),
    ]);
    const callsInInput = input.filter((item) => item.type === 'function_call').map((item) => (item.type === 'function_call' ? item.call_id : ''));
    expect(callsInInput).toEqual([env.gateway.callId('call_r_1'), env.gateway.callId('call_r_2')]);

    expect(env.ofType(run.id, 'usage.updated').map((event) => [event.inputTokens, event.outputTokens, event.totalTokens])).toEqual([
      [100, 10, 110],
      [250, 15, 265],
    ]);
  });

  it('records the plan from a plan tool as plan.updated', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_p_1', name: 'UpdatePlan', args: { step: 'write tests' } }]), textStep('Planned.'));
    const run = env.enqueue('Plan the work');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    const plans = env.ofType(run.id, 'plan.updated');
    expect(plans.map((event) => event.entries)).toEqual([
      [
        { content: 'write tests', priority: 'high', status: 'in_progress' },
        { content: 'verify', priority: 'medium', status: 'pending' },
      ],
    ]);
    const [call] = env.ofType(run.id, 'tool.call');
    expect(plans[0]?.seq).toBeGreaterThan(call?.seq ?? Infinity);
  });

  it('includes the locations reported by the tool in tool.call', async () => {
    const env = await makeEnv({ mode: 'acceptEdits' });
    const target = `${env.project}/notes.txt`;
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'hi' } }]), textStep('Written.'));
    const run = env.enqueue('Write notes');

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'tool.call')[0]).toMatchObject({ kind: 'edit', title: `Write ${target}`, locations: [{ path: target }] });
    expect(env.ofType(run.id, 'tool.completed')[0]).toMatchObject({ callId: env.gateway.callId('call_w_1'), status: 'completed', output: `wrote ${target}` });
  });
});
