import { describe, expect, it } from 'vitest';
import type { CreateResponseBody } from '@momonga/protocol';
import { usageOf } from '@momonga/testkit';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import { firstRequestOf, summaryOnlyBudget } from './token-budget.ts';

type Env = Awaited<ReturnType<typeof makeEnv>>;

const echo = (callId: string) => callsStep([{ callId, name: 'Echo', args: { value: callId } }], 'auto');

const requests = (env: Env, runId: string) =>
  env.ofType(runId, 'model.requested').map((event) => {
    const body = event.body as CreateResponseBody;
    if (event.budget === undefined) throw new Error('a model request carries no budget record');
    return { body, budget: event.budget, inputUpper: event.budget.reservedTokens - event.budget.maxOutputTokens, seq: event.seq };
  });

describe('the token limit of a run is a ceiling held by the same admission as the money limit', () => {
  it('caps the output of a request at what the limit leaves, so a model that fills the cap cannot pass the limit', async () => {
    const probe = await firstRequestOf();
    const limit = probe.inputUpper + 1000;
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_1', name: 'Echo', args: { value: 'x' } }], usageOf(probe.inputUpper, 900)), textStep('never sent'));
    const run = env.enqueue('Work', { limits: { maxTotalTokens: limit } });

    await env.runOnce(env.worker());

    const sent = requests(env, run.id);
    expect(sent).toHaveLength(1);
    const [first] = sent;
    expect(first?.body.max_output_tokens).toBe(limit - (first?.inputUpper as number));
    expect(first?.body.max_output_tokens).toBeLessThan(4096);
    expect(first?.budget.reservedTokens).toBe(limit);
    const ended = env.run(run.id);
    expect(ended).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    expect(ended.usage.totalTokens).toBeLessThanOrEqual(limit);
    expect(env.ofType(run.id, 'budget.exhausted')).toEqual([expect.objectContaining({ dimension: 'tokens', limit })]);
    expect(env.gateway.script).toHaveLength(1);
    expect(env.fold(run.id).notes.some((note) => note.code === 'budget_exhausted' && note.message.includes('token limit'))).toBe(true);
    expect(env.store.treeSpend(run.id)).toMatchObject({ reservedTokens: 0, reservedNano: 0 });
  });

  it('sends nothing when the limit does not hold the first request at the output floor', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('never sent'));
    const run = env.enqueue('Work', { limits: { maxTotalTokens: 100 } });

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    expect(env.ofType(run.id, 'budget.exhausted')).toEqual([expect.objectContaining({ dimension: 'tokens', cause: 'cap_too_small', spent: 0, limit: 100 })]);
    expect(env.ofType(run.id, 'model.requested')).toEqual([]);
    expect(env.gateway.streams).toHaveLength(0);
  });

  it('asks for the closing summary under the same admission when a tool step no longer fits and the summary does', async () => {
    const budget = await summaryOnlyBudget();
    const limit = budget.limits.maxTotalTokens;
    const { left } = budget;
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_1', name: 'Echo', args: { value: 'x' } }], budget.usageUpTo()), textStep('Summary.'), echo('never_sent'));
    const run = env.enqueue('Work', { limits: { maxTotalTokens: limit } });

    await env.runOnce(env.worker());

    const sent = requests(env, run.id);
    expect(sent).toHaveLength(2);
    const summary = sent[1];
    expect(summary?.body.tool_choice).toBe('none');
    expect(summary?.body.tools ?? []).toEqual([]);
    expect(summary?.body.max_output_tokens).toBe(left - (summary?.inputUpper as number));
    expect(summary?.body.max_output_tokens).toBeGreaterThanOrEqual(256);
    const exhausted = env.ofType(run.id, 'budget.exhausted');
    expect(exhausted).toEqual([expect.objectContaining({ dimension: 'tokens', cause: 'cap_too_small', spent: limit - left, limit })]);
    expect(exhausted[0]?.seq).toBeLessThan(summary?.seq as number);
    const ended = env.run(run.id);
    expect(ended).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    expect(ended.usage.totalTokens).toBeLessThanOrEqual(limit);
    expect(env.gateway.script).toHaveLength(1);
  });

  it('records which limit asked for the summary when the steps run out', async () => {
    const env = await makeEnv();
    env.gateway.script.push(echo('call_1'), textStep('Summary.'));
    const run = env.enqueue('Work', { limits: { maxSteps: 1 } });

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'max_steps' });
    expect(env.ofType(run.id, 'budget.exhausted')).toEqual([expect.objectContaining({ dimension: 'steps', cause: 'limit', spent: 1, limit: 1 })]);
    expect(env.gateway.streams).toHaveLength(2);
  });
});
