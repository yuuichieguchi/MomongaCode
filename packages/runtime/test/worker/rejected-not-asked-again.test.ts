import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REJECTED_AGAIN_OUTPUT } from '../../src/worker/tool-step.ts';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const writeOf = (env: Env, callId: string, content: string) => callsStep([{ callId, name: 'Write', args: { file_path: path.join(env.project, 'out.txt'), content } }]);

describe('a call a person rejected is not asked again unchanged in the same run', () => {
  it('settles an identical repeat as rejected, without a second request for approval, and the run goes on', async () => {
    const env = await makeEnv();
    env.gateway.script.push(writeOf(env, 'call_w_1', 'x'));
    const run = await env.enqueue('Write it');
    await env.runOnce(env.worker());
    await env.resolveApproval(run.id, 'reject_once');
    env.gateway.script.push(writeOf(env, 'call_w_2', 'x'), textStep('I will not write it.'));

    await env.runOnce(env.worker('worker-2'));

    expect(env.ofType(run.id, 'tool.permission.requested')).toHaveLength(1);
    const repeat = env.ofType(run.id, 'tool.completed').find((event) => event.callId === env.gateway.callId('call_w_2'));
    expect(repeat).toMatchObject({ status: 'failed', output: REJECTED_AGAIN_OUTPUT });
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(fs.existsSync(path.join(env.project, 'out.txt'))).toBe(false);
  });

  it('asks again for a call that changed', async () => {
    const env = await makeEnv();
    env.gateway.script.push(writeOf(env, 'call_w_1', 'x'));
    const run = await env.enqueue('Write it');
    await env.runOnce(env.worker());
    await env.resolveApproval(run.id, 'reject_once');
    env.gateway.script.push(writeOf(env, 'call_w_2', 'something else'));

    await env.runOnce(env.worker('worker-2'));

    expect(env.ofType(run.id, 'tool.permission.requested')).toHaveLength(2);
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
  });

  it('does not hold again a call a person rejected under a mandate', async () => {
    const env = await makeEnv();
    const target = path.join(env.project, 'out.txt');
    const mandate = { scope: { allow: ['Bash(ls:*)'], ask: [`Write(/${target})`] } };
    env.gateway.script.push(writeOf(env, 'call_w_1', 'x'), textStep('Waiting for the write.'));
    const run = await env.enqueue('Write it', { mandate });
    await env.runOnce(env.worker());
    await env.resolveApproval(run.id, 'reject_once');
    env.gateway.script.push(writeOf(env, 'call_w_2', 'x'), textStep('I will not write it.'));

    await env.runOnce(env.worker('worker-2'));

    expect(env.ofType(run.id, 'tool.held')).toHaveLength(1);
    expect(env.ofType(run.id, 'tool.permission.requested')).toHaveLength(1);
    const repeat = env.ofType(run.id, 'tool.completed').find((event) => event.callId === env.gateway.callId('call_w_2'));
    expect(repeat).toMatchObject({ status: 'failed', output: REJECTED_AGAIN_OUTPUT });
    expect(fs.existsSync(target)).toBe(false);
  });
});
