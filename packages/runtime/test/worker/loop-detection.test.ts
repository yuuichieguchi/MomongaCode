import { describe, expect, it } from 'vitest';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const echo = (callId: string, value: string) => callsStep([{ callId, name: 'Echo', args: { value } }]);

describe('worker loop detection', () => {
  it('stops at loop before executing the third identical call with identical outputs', async () => {
    const env = await makeEnv();
    env.gateway.script.push(echo('call_l_1', 'same'), echo('call_l_2', 'same'), echo('call_l_3', 'same'), textStep('never sent'));
    const run = env.enqueue('Loop');

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'loop' });
    expect(env.toolbox.executions).toHaveLength(2);
    expect(env.gateway.streams).toHaveLength(3);
    expect(env.ofType(run.id, 'tool.started').map((event) => event.callId)).toEqual(['call_l_1', 'call_l_2']);
    expect(env.ofType(run.id, 'notice').length).toBeGreaterThan(0);
  });

  it('continues when the repeated call produced different outputs', async () => {
    const env = await makeEnv();
    const count = (callId: string) => callsStep([{ callId, name: 'Counter', args: { value: 'same' } }]);
    env.gateway.script.push(count('call_c_1'), count('call_c_2'), count('call_c_3'), textStep('Counted.'));
    const run = env.enqueue('Count');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.toolbox.executions).toHaveLength(3);
  });

  it('does not treat a repeat separated by a different call as a loop', async () => {
    const env = await makeEnv();
    env.gateway.script.push(echo('call_a_1', 'a'), echo('call_a_2', 'a'), echo('call_b_1', 'b'), echo('call_a_3', 'a'), textStep('Done.'));
    const run = env.enqueue('Mix');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.toolbox.executions.map((execution) => execution.input['value'])).toEqual(['a', 'a', 'b', 'a']);
  });

  it('uses loopThreshold from run.limits', async () => {
    const env = await makeEnv();
    env.gateway.script.push(echo('call_l_1', 'same'), echo('call_l_2', 'same'), textStep('never sent'));
    const run = env.enqueue('Loop', { limits: { loopThreshold: 2 } });

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'loop' });
    expect(env.toolbox.executions).toHaveLength(1);
    expect(env.gateway.streams).toHaveLength(2);
  });
});
