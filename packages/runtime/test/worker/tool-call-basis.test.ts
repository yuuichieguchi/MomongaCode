import { describe, expect, it } from 'vitest';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

describe('rule 5: tool.started records the basis', () => {
  it('records read_only for a Bash call the analysis approved', async () => {
    const env = await makeEnv({ mode: 'default' });
    env.gateway.script.push(callsStep([{ callId: 'call_b_1', name: 'Bash', args: { command: 'ls' } }]), textStep('Done.'));
    const run = env.enqueue('List');
    await env.runOnce(env.worker());
    expect(env.ofType(run.id, 'tool.started')[0]).toMatchObject({ basis: 'read_only' });
  });

  it('records another basis for a Bash call that a mode allowed', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(callsStep([{ callId: 'call_b_2', name: 'Bash', args: { command: 'ls' } }]), textStep('Done.'));
    const run = env.enqueue('List');
    await env.runOnce(env.worker());
    const [started] = env.ofType(run.id, 'tool.started');
    expect(started?.basis).toBeDefined();
    expect(started?.basis).not.toBe('read_only');
  });
});
