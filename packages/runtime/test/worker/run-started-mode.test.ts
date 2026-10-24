import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

describe('run.started records the permission mode', () => {
  it('records the session mode of the claim', async () => {
    const env = await makeEnv({ mode: 'acceptEdits' });
    env.gateway.script.push(textStep('Done.'));
    const run = env.enqueue();

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.ofType(run.id, 'run.started').map((event) => event.mode)).toEqual(['acceptEdits']);
    expect(env.fold(run.id).mode).toBe('acceptEdits');
  });

  it('records the mode of each claim, so a PATCH between claims is reflected by the next claim', async () => {
    const env = await makeEnv();
    const target = path.join(env.project, 'mode.txt');
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'x' } }]), textStep('Written.'));
    const run = env.enqueue('Write the file');

    expect(await env.runOnce(env.worker())).toBe('yielded');
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    expect(env.fold(run.id).mode).toBe('default');

    env.setMode('plan');
    env.resolveApproval(run.id, 'allow_once');
    expect(await env.runOnce(env.worker('worker-2'))).toBe('yielded');

    expect(env.ofType(run.id, 'run.started').map((event) => event.mode)).toEqual(['default', 'plan']);
    const state = env.fold(run.id);
    expect(state.mode).toBe('plan');
    expect(state.pins).toEqual(env.ofType(run.id, 'run.started')[0]?.pins);
  });
});
