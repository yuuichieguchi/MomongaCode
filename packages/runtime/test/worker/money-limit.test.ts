import { describe, expect, it } from 'vitest';
import { definePriceTable } from '@momonga/observability';
import type { CreateResponseBody } from '@momonga/protocol';
import { admitRequest, usdOfNano } from '@momonga/protocol';
import type { AdmissionAsk, TreeSpend } from '@momonga/protocol';
import { OUTPUT_FLOOR_TOKENS, admitStep } from '../../src/worker/budget.ts';
import { FAKE_ADAPTER, FAKE_PROVIDER, PRIMARY_TARGET } from './fake-gateway.ts';
import { makeEnv } from './harness.ts';
import { callsStep, failedStep, textStep } from './scripts.ts';

const PRICES = definePriceTable([{ provider: FAKE_PROVIDER, model: 'upstream-a', effectiveFrom: '2026-01-01', inputPerMTok: 0.001, outputPerMTok: 15, currency: 'USD' }]);

type Env = Awaited<ReturnType<typeof makeEnv>>;

const metered = (env: Env): void => {
  env.gateway.chainsByModel[env.session.model] = [PRIMARY_TARGET];
  env.gateway.memberFacts = { [PRIMARY_TARGET]: { adapter: FAKE_ADAPTER, upstream: 'upstream-a', answers: 'model', billing: 'metered', provider: FAKE_PROVIDER } };
  env.gateway.billed = { inputPerMTok: 0.001, outputPerMTok: 15 };
  env.gateway.prices = PRICES;
};

const worker = (env: Env) => env.worker('worker-1');

const requestBodies = (env: Env, runId: string): CreateResponseBody[] => env.ofType(runId, 'model.requested').map((event) => event.body as CreateResponseBody);

const read = (callId: string, env: Env) => callsStep([{ callId, name: 'Glob', args: { pattern: `*.${callId}`, path: env.project } }]);

describe('the money limit of a run is a ceiling held by admission before each model request', () => {
  it('stops with the reason budget before the request that would not fit, and never spends past the limit', async () => {
    const env = await makeEnv();
    metered(env);
    const scripted = 30;
    for (let index = 0; index < scripted; index += 1) env.gateway.script.push(read(`call_${index}`, env));
    const run = await env.enqueue('Look around', { limits: { maxCostUsd: 0.004, maxSteps: 100 } });

    await env.runOnce(worker(env));

    const ended = env.run(run.id);
    expect(ended).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    expect(ended.usage.costNano).toBeGreaterThan(0);
    expect(ended.usage.costNano).toBeLessThanOrEqual(4_000_000);
    const [exhausted] = env.ofType(run.id, 'budget.exhausted');
    expect(exhausted).toMatchObject({ dimension: 'cost', limit: 4_000_000 });
    expect(['limit', 'cap_too_small']).toContain(exhausted?.cause);
    const sent = env.ofType(run.id, 'model.requested').length;
    expect(env.ofType(run.id, 'model.responded')).toHaveLength(sent);
    expect(sent).toBeGreaterThan(1);
    expect(sent).toBeLessThan(scripted);
    expect(env.gateway.script).toHaveLength(scripted - sent);
    expect(env.fold(run.id).notes.some((note) => note.code === 'budget_exhausted' && note.message.includes('money limit'))).toBe(true);
    expect(env.store.treeSpend(run.id)).toMatchObject({ reservedNano: 0, reservedTokens: 0 });
  });

  it('shrinks the output cap of the request as the money left shrinks, never below the floor', async () => {
    const env = await makeEnv();
    metered(env);
    env.gateway.script.push(read('call_1', env), read('call_2', env), textStep('done'));
    const run = await env.enqueue('Look around', { limits: { maxCostUsd: 0.004 } });

    await env.runOnce(worker(env));

    const caps = requestBodies(env, run.id).map((body) => body.max_output_tokens ?? Number.POSITIVE_INFINITY);
    expect(caps.length).toBeGreaterThan(1);
    expect(caps[0]).toBeLessThan(4096);
    for (const [index, cap] of caps.entries()) {
      expect(cap).toBeGreaterThanOrEqual(256);
      if (index > 0) expect(cap).toBeLessThan(caps[index - 1] as number);
    }
  });

  it('sends nothing on a chain with no price while a money limit is declared, naming unpriced', async () => {
    const env = await makeEnv();
    metered(env);
    env.gateway.script.push(textStep('never sent'));
    const run = await env.enqueue('Say hello', { limits: { maxCostUsd: 1 } });

    env.gateway.prices = definePriceTable([]);

    await env.runOnce(worker(env));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    expect(env.ofType(run.id, 'budget.exhausted')).toEqual([expect.objectContaining({ dimension: 'cost', cause: 'unpriced', limit: 1_000_000_000 })]);
    expect(env.ofType(run.id, 'model.requested')).toEqual([]);
    expect(env.gateway.script).toHaveLength(1);
  });

  it('runs a local target, priced at zero, under any money limit', async () => {
    const env = await makeEnv();
    env.gateway.chainsByModel[env.session.model] = [PRIMARY_TARGET];
    env.gateway.memberFacts = { [PRIMARY_TARGET]: { adapter: FAKE_ADAPTER, upstream: 'local-a', answers: 'model', billing: 'local' } };
    env.gateway.script.push(textStep('Hello.'));
    const run = await env.enqueue('Say hello', { limits: { maxCostUsd: 0.000000001 } });

    await env.runOnce(worker(env));

    expect(env.run(run.id).status).toBe('COMPLETED');
  });

  it('does not continue after a call that came back billed without a cost', async () => {
    const env = await makeEnv();
    metered(env);
    env.gateway.billed = 'unpriced';
    env.gateway.script.push(read('call_1', env), textStep('never sent'));
    const run = await env.enqueue('Look around', { limits: { maxCostUsd: 1 } });

    await env.runOnce(worker(env));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget', usage: { unpricedCalls: 1 } });
    expect(env.ofType(run.id, 'budget.exhausted')).toEqual([expect.objectContaining({ dimension: 'cost', cause: 'unpriced' })]);
    expect(env.ofType(run.id, 'model.requested')).toHaveLength(1);
  });

  it('changes nothing for a run without a money limit: an unpriced call is counted and the run goes on', async () => {
    const env = await makeEnv();
    metered(env);
    env.gateway.billed = 'unpriced';
    env.gateway.script.push(read('call_1', env), textStep('done'));
    const run = await env.enqueue('Look around');

    await env.runOnce(worker(env));

    expect(env.run(run.id)).toMatchObject({ status: 'COMPLETED', usage: { unpricedCalls: 2 } });
    expect(env.ofType(run.id, 'budget.exhausted')).toEqual([]);
    expect(requestBodies(env, run.id).every((body) => body.max_output_tokens === 4096)).toBe(true);
  });
});

describe('the gateway is the authority on the price of a request', () => {
  it('asks the gateway for one quote per model step, and for none when the run has no money limit', async () => {
    const limited = await makeEnv();
    metered(limited);
    limited.gateway.script.push(read('call_1', limited), textStep('done'));
    const run = await limited.enqueue('Look around', { limits: { maxCostUsd: 1 } });
    await limited.runOnce(worker(limited));

    const free = await makeEnv();
    metered(free);
    free.gateway.script.push(textStep('done'));
    await free.enqueue('Say hello');
    await free.runOnce(worker(free));

    expect(limited.run(run.id).status).toBe('COMPLETED');
    expect(limited.gateway.quotes).toEqual([limited.session.model, limited.session.model]);
    expect(free.gateway.quotes).toEqual([]);
  });

  it('sends the most the request may cost and the input bound it was reserved for, and records the reservation with the quote', async () => {
    const env = await makeEnv();
    metered(env);
    env.gateway.script.push(textStep('done'));
    const run = await env.enqueue('Say hello', { limits: { maxCostUsd: 1 } });

    await env.runOnce(worker(env));

    const [requested] = env.ofType(run.id, 'model.requested');
    const body = requested?.body as CreateResponseBody;
    const budget = requested?.budget;
    expect(budget?.quote).toEqual({ inUnits: '1000000', outUnits: '15000000000', priceVersions: ['2026-01-01'] });
    expect(budget?.maxOutputTokens).toBe(body.max_output_tokens);
    const inputUpper = (budget?.reservedTokens as number) - (budget?.maxOutputTokens as number);
    expect(body.momonga).toMatchObject({ max_cost_nano: budget?.reservedNano, max_input_tokens: inputUpper });
    expect(budget?.reservedNano).toBe(Math.ceil((inputUpper * 1_000_000 + (body.max_output_tokens as number) * 15_000_000_000) / 1_000_000));
  });

  it('stops with the reason budget when the gateway refuses the request over its ceiling, since the price rose after the quote', async () => {
    const env = await makeEnv();
    metered(env);
    env.gateway.script.push(failedStep('budget_exceeded'));
    const run = await env.enqueue('Say hello', { limits: { maxCostUsd: 1 } });

    await env.runOnce(worker(env));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    expect(env.ofType(run.id, 'budget.exhausted')).toEqual([expect.objectContaining({ dimension: 'cost', cause: 'cap_too_small', limit: 1_000_000_000 })]);
    expect(env.store.treeSpend(run.id)).toMatchObject({ reservedNano: 0, reservedTokens: 0 });
  });
});

describe('the first request of a run is admitted by the same rule as every other', () => {
  const price = { inUnits: 3_000_000n, outUnits: 15_000_000n };
  const size = { inputTokens: 1000, marginTokens: 32, maxOutputTokens: 4096 };
  const NOTHING: TreeSpend = { totalTokens: 0, costNano: 0, unpricedCalls: 0, reservedTokens: 0, reservedNano: 0 };
  const firstRequest = (maxCostNano: number) =>
    admitStep({ size, limits: { maxTotalTokens: 1_000_000, maxCostNano }, price, unpricedCalls: 0, spentNano: 0, ledger: { admitModelRequest: (ask: AdmissionAsk) => admitRequest(ask, NOTHING) } });
  const worstCaseAtFloorNano = Math.ceil(((size.inputTokens + size.marginTokens) * 3_000_000 + OUTPUT_FLOOR_TOKENS * 15_000_000) / 1_000_000);

  it('admits it at the output floor when the limit is exactly its worst case there', () => {
    expect(firstRequest(worstCaseAtFloorNano)).toMatchObject({ kind: 'admitted', maxOutputTokens: OUTPUT_FLOOR_TOKENS, reservedNano: worstCaseAtFloorNano, inputUpper: 1032 });
  });

  it('refuses it one nano below, naming cap_too_small with nothing spent and the smallest budget that admits it', () => {
    expect(firstRequest(worstCaseAtFloorNano - 1)).toEqual({ kind: 'exhausted', exhausted: { dimension: 'cost', cause: 'cap_too_small', spent: 0, limit: worstCaseAtFloorNano - 1, admitsAt: worstCaseAtFloorNano } });
  });

  it('names the smallest token budget that admits a request the tokens left do not pay for', () => {
    const upper = size.inputTokens + size.marginTokens + OUTPUT_FLOOR_TOKENS;
    const refused = admitStep({ size, limits: { maxTotalTokens: upper - 1 }, price: undefined, unpricedCalls: 0, spentNano: 0, ledger: { admitModelRequest: (ask: AdmissionAsk) => admitRequest(ask, { ...NOTHING, totalTokens: 10 }) } });
    expect(refused).toEqual({ kind: 'exhausted', exhausted: { dimension: 'tokens', cause: 'cap_too_small', spent: 10, limit: upper - 1, admitsAt: upper + 10 } });
  });

  it('stops a run whose money limit pays for no request before anything is sent, saying so', async () => {
    const env = await makeEnv();
    metered(env);
    env.gateway.script.push(textStep('never sent'));
    const run = await env.enqueue('Say hello', { limits: { maxCostUsd: 0.000000001 } });

    await env.runOnce(worker(env));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    const [exhausted] = env.ofType(run.id, 'budget.exhausted');
    expect(exhausted).toEqual({ ...exhausted, dimension: 'cost', cause: 'cap_too_small', spent: 0, limit: 1, admitsAt: expect.any(Number) });
    expect(exhausted?.admitsAt).toBeGreaterThan(1);
    expect(env.ofType(run.id, 'model.requested')).toEqual([]);
    expect(env.gateway.script).toHaveLength(1);
    const named = `A budget of ${usdOfNano(exhausted?.admitsAt ?? 0)} USD admits the next model request`;
    expect(env.fold(run.id).notes.some((note) => note.code === 'budget_exhausted' && note.message.includes('does not pay for another model request') && note.message.includes(named))).toBe(true);
  });
});
