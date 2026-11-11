import { describe, expect, it } from 'vitest';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const inputOf = (body: unknown): unknown[] => (body as { input: unknown[] }).input;

describe('model.requested records the prefix relation to the previous request of the run (section 1)', () => {
  it('records the whole previous request as preserved when no named event lies between two requests', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'c1', name: 'Echo', args: { value: 'x' } }]), textStep('Done.'));
    const run = await env.enqueue('Echo then finish');

    await env.runOnce(env.worker());

    const [first, second] = env.ofType(run.id, 'model.requested');
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(second?.prefix).toEqual({ preservedItems: inputOf(first?.body).length, toolsChanged: false, causes: [] });
    expect(inputOf(second?.body).slice(0, inputOf(first?.body).length)).toEqual(inputOf(first?.body));
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.code === 'prefix_unexplained')).toEqual([]);
  });

  it('attributes a changed offer at a new claim to the claim event, with the tools changed', async () => {
    const env = await makeEnv();
    env.toolbox.hooks.Echo = async () => {
      const changed = env.store.setPermissionMode(env.session.id, 'plan');
      if (changed.kind !== 'ok') throw new Error(`the mode could not be changed: ${changed.kind}`);
    };
    env.gateway.script.push(callsStep([{ callId: 'c1', name: 'Echo', args: { value: 'x' } }]), textStep('Done.'));
    const run = await env.enqueue('Echo then finish');

    await env.runOnce(env.worker());
    await env.runOnce(env.worker());

    const [, second] = env.ofType(run.id, 'model.requested');
    expect(second?.prefix).toEqual({ preservedItems: 0, toolsChanged: true, causes: ['claim'] });
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.code === 'prefix_unexplained')).toEqual([]);
  });
});
