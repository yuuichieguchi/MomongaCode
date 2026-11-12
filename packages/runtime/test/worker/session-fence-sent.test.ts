import { describe, expect, it } from 'vitest';
import { sessionFenceOf } from '@momonga/protocol';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

describe('the runtime sends its session fence to the gateway', () => {
  it('a create request carries the session fence as momonga.fence, and the tool output fence in its input uses that boundary', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(callsStep([{ callId: 'call_f_1', name: 'Fetch', args: { value: 'x' } }]), textStep('Done.'));
    const run = await env.enqueue('Fetch');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    const fence = sessionFenceOf(env.session);
    expect(env.gateway.streams.map((stream) => stream.body.momonga?.fence)).toEqual([fence, fence]);
    expect(JSON.stringify(env.gateway.streams[1]?.body.input)).toContain(`boundary=\\"${fence}`);
  });
});
