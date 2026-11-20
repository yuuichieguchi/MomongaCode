import { describe, expect, it } from 'vitest';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { MODEL_ID, textStep } from './scripts.ts';

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

  it('sends the standard level when none is chosen', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(8000, { reasoning: { control: 'reasoning_effort', lowest: 'low' } }) });
    env.gateway.script.push(textStep('done'));
    const run = await env.enqueue('think');
    await env.runOnce(env.worker('worker-1'));
    expect(firstBody(env, run.id)).toMatchObject({ reasoning: { effort: 'medium' } });
  });

  it('keeps the visible output bound and admits the thinking budget on top of it for a model that thinks by budget', async () => {
    const reasoning = { control: 'thinking', form: 'budget', budgets: { high: 1024 }, off: 'disabled' } as const;
    const requestedOf = async (effort: 'high' | 'none' | undefined) => {
      const env = await makeEnv({ capabilities: capabilitiesFor(64000, { reasoning, maxOutputTokens: 32000 }) });
      if (effort !== undefined) env.store.setEffort(env.session.id, effort);
      env.gateway.script.push(textStep('done'));
      const run = await env.enqueue('think');
      await env.runOnce(env.worker('worker-1'));
      return env.ofType(run.id, 'model.requested').find((event) => event.step === 1);
    };
    const plain = await requestedOf('none');
    const thinking = await requestedOf('high');
    const standard = await requestedOf(undefined);
    expect(standard?.body).toMatchObject({ reasoning: { effort: 'high' } });
    expect(standard?.budget?.maxOutputTokens).toBe(thinking?.budget?.maxOutputTokens);
    expect(plain?.body).toMatchObject({ max_output_tokens: expect.any(Number) });
    expect(thinking?.body).toMatchObject({ reasoning: { effort: 'high' }, max_output_tokens: (plain?.body as { max_output_tokens: number }).max_output_tokens });
    expect(thinking?.budget?.maxOutputTokens).toBe((plain?.budget?.maxOutputTokens as number) + 1024);
  });

  it('runs a session that chose no level at the level the listing gives its model (its saved level, else models.effort), and a chosen level wins over it', async () => {
    const reasoning = { control: 'reasoning_effort', lowest: 'low' } as const;
    const env = await makeEnv({ capabilities: capabilitiesFor(8000, { reasoning }) });
    env.gateway.effortsByModel[MODEL_ID] = 'xhigh';
    env.gateway.script.push(textStep('done'));
    const saved = await env.enqueue('think');
    await env.runOnce(env.worker('worker-1'));
    expect(firstBody(env, saved.id)).toMatchObject({ reasoning: { effort: 'xhigh' } });
    expect(env.ofType(saved.id, 'run.started')[0]?.pins['effort']).toBe('xhigh');
    env.store.setEffort(env.session.id, 'low');
    env.gateway.script.push(textStep('done'));
    const chosen = await env.enqueue('think again');
    await env.runOnce(env.worker('worker-1'));
    expect(firstBody(env, chosen.id)).toMatchObject({ reasoning: { effort: 'low' } });
  });

  it('sends a level saved for a model whose settings entry holds only its id as the listing reports its control allows: as saved, fitted, or not at all', async () => {
    const sentFor = async (reasoning: { control: 'reasoning_effort'; lowest: 'low' } | undefined, saved: 'high' | 'minimal') => {
      const env = await makeEnv({ capabilities: capabilitiesFor(8000, reasoning === undefined ? {} : { reasoning }) });
      env.gateway.effortsByModel[MODEL_ID] = saved;
      env.gateway.script.push(textStep('done'));
      const run = await env.enqueue('think');
      await env.runOnce(env.worker('worker-1'));
      return (firstBody(env, run.id) as { reasoning?: unknown }).reasoning;
    };
    const reasoning = { control: 'reasoning_effort', lowest: 'low' } as const;
    expect([await sentFor(reasoning, 'high'), await sentFor(reasoning, 'minimal'), await sentFor(undefined, 'high')]).toEqual([{ effort: 'high' }, { effort: 'low' }, undefined]);
  });
});
