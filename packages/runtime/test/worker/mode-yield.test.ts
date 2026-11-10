import { describe, expect, it } from 'vitest';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const toolNamesOf = (body: unknown): string[] => {
  const tools = (body as { tools?: { name: string }[] }).tools ?? [];
  return tools.map((tool) => tool.name);
};

describe('a mode change ends the claim (Q19, 0.2 #20, 4.6)', () => {
  it('yields QUEUED with a refunded attempt at the next step boundary, before building with the old offer', async () => {
    const env = await makeEnv();
    env.toolbox.hooks.Echo = async () => {
      const changed = env.store.setPermissionMode(env.session.id, 'plan');
      if (changed.kind !== 'ok') throw new Error(`the mode could not be changed: ${changed.kind}`);
    };
    env.gateway.script.push(callsStep([{ callId: 'c1', name: 'Echo', args: { value: 'x' } }]), textStep('Done.'));
    const run = env.enqueue('Echo then finish');

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'model.requested')).toHaveLength(1);
    expect(env.ofType(run.id, 'tool.completed')).toHaveLength(1);
    expect(env.run(run.id).status).toBe('QUEUED');
    expect(env.run(run.id).attempts).toBe(0);
  });

  it('offers what the new mode allows at the next claim, recorded with one run.started of that mode', async () => {
    const env = await makeEnv();
    env.toolbox.hooks.Echo = async () => {
      const changed = env.store.setPermissionMode(env.session.id, 'plan');
      if (changed.kind !== 'ok') throw new Error(`the mode could not be changed: ${changed.kind}`);
    };
    env.gateway.script.push(callsStep([{ callId: 'c1', name: 'Echo', args: { value: 'x' } }]), textStep('Done.'));
    const run = env.enqueue('Echo then finish');

    await env.runOnce(env.worker());
    await env.runOnce(env.worker());

    const requests = env.ofType(run.id, 'model.requested');
    expect(requests).toHaveLength(2);
    expect(toolNamesOf(requests[0]?.body)).toContain('Write');
    expect(toolNamesOf(requests[1]?.body)).not.toContain('Write');
    expect(env.ofType(run.id, 'run.started').map((event) => event.mode)).toEqual(['manual', 'plan']);
    expect(env.run(run.id).status).toBe('COMPLETED');
  });
});
