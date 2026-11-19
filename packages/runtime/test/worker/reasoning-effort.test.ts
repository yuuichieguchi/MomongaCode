import { describe, expect, it } from 'vitest';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';

const firstBody = (env: Awaited<ReturnType<typeof makeEnv>>, runId: string) => env.ofType(runId, 'model.requested').find((event) => event.step === 1)?.body;

describe('the reasoning effort of a session on the ordinary model step', () => {
  it('sends the chosen effort clamped to the levels the model declares', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(8000, { reasoning: { control: 'reasoning_effort', lowest: 'low' } }) });
    env.store.setEffort(env.session.id, 'minimal');
    env.gateway.script.push(textStep('done'));
    const run = await env.enqueue('think');
    await env.runOnce(env.worker('worker-1'));
    expect(firstBody(env, run.id)).toMatchObject({ reasoning: { effort: 'low' } });
    expect(env.ofType(run.id, 'run.started')[0]?.pins['effort']).toBe('minimal');
  });

  it('sends no effort to a model that declares no reasoning control', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(8000) });
    env.store.setEffort(env.session.id, 'high');
    env.gateway.script.push(textStep('done'));
    const run = await env.enqueue('think');
    await env.runOnce(env.worker('worker-1'));
    expect(firstBody(env, run.id)).not.toHaveProperty('reasoning');
  });

  it('sends no effort when none is chosen', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(8000, { reasoning: { control: 'reasoning_effort', lowest: 'low' } }) });
    env.gateway.script.push(textStep('done'));
    const run = await env.enqueue('think');
    await env.runOnce(env.worker('worker-1'));
    expect(firstBody(env, run.id)).not.toHaveProperty('reasoning');
  });

  it('keeps the visible output bound and admits the thinking budget on top of it for a model that thinks by budget', async () => {
    const reasoning = { control: 'thinking', form: 'budget', budgets: { high: 1024 } } as const;
    const requestedOf = async (effort: 'high' | undefined) => {
      const env = await makeEnv({ capabilities: capabilitiesFor(64000, { reasoning, maxOutputTokens: 32000 }) });
      if (effort !== undefined) env.store.setEffort(env.session.id, effort);
      env.gateway.script.push(textStep('done'));
      const run = await env.enqueue('think');
      await env.runOnce(env.worker('worker-1'));
      return env.ofType(run.id, 'model.requested').find((event) => event.step === 1);
    };
    const plain = await requestedOf(undefined);
    const thinking = await requestedOf('high');
    expect(plain?.body).toMatchObject({ max_output_tokens: expect.any(Number) });
    expect(thinking?.body).toMatchObject({ reasoning: { effort: 'high' }, max_output_tokens: (plain?.body as { max_output_tokens: number }).max_output_tokens });
    expect(thinking?.budget?.maxOutputTokens).toBe((plain?.budget?.maxOutputTokens as number) + 1024);
  });
});
