import { describe, expect, it } from 'vitest';
import { definePriceTable } from '@momonga/observability';
import type { CreateResponseBody } from '@momonga/protocol';
import { chainPrice } from '../../src/worker/budget.ts';
import { FAKE_ADAPTER, FAKE_PROVIDER, PRIMARY_TARGET } from './fake-gateway.ts';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const PRICES = definePriceTable([{ provider: FAKE_PROVIDER, model: 'upstream-a', effectiveFrom: '2026-01-01', inputPerMTok: 0.001, outputPerMTok: 15, currency: 'USD' }]);

type Env = Awaited<ReturnType<typeof makeEnv>>;

const metered = (env: Env): void => {
  env.gateway.chainsByModel[env.session.model] = [PRIMARY_TARGET];
  env.gateway.memberFacts = { [PRIMARY_TARGET]: { adapter: FAKE_ADAPTER, upstream: 'upstream-a', answers: 'model', billing: 'metered', provider: FAKE_PROVIDER } };
  env.gateway.billed = { inputPerMTok: 0.001, outputPerMTok: 15 };
};

const worker = (env: Env) => env.worker('worker-1', { priceTable: () => PRICES });

const requestBodies = (env: Env, runId: string): CreateResponseBody[] => env.ofType(runId, 'model.requested').map((event) => event.body as CreateResponseBody);

const read = (callId: string, env: Env) => callsStep([{ callId, name: 'Glob', args: { pattern: `*.${callId}`, path: env.project } }]);

describe('the money limit of a run is a ceiling held by admission before each model request', () => {
  it('stops with the reason budget before the request that would not fit, and never spends past the limit', async () => {
    const env = await makeEnv();
    metered(env);
    const scripted = 30;
    for (let index = 0; index < scripted; index += 1) env.gateway.script.push(read(`call_${index}`, env));
    const run = env.enqueue('Look around', { limits: { maxCostUsd: 0.004, maxSteps: 100 } });

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
    const run = env.enqueue('Look around', { limits: { maxCostUsd: 0.004 } });

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
    const run = env.enqueue('Say hello', { limits: { maxCostUsd: 1 } });

    await env.runOnce(env.worker('worker-1', { priceTable: () => definePriceTable([]) }));

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
    const run = env.enqueue('Say hello', { limits: { maxCostUsd: 0.000000001 } });

    await env.runOnce(worker(env));

    expect(env.run(run.id).status).toBe('COMPLETED');
  });

  it('does not continue after a call that came back billed without a cost', async () => {
    const env = await makeEnv();
    metered(env);
    env.gateway.billed = 'unpriced';
    env.gateway.script.push(read('call_1', env), textStep('never sent'));
    const run = env.enqueue('Look around', { limits: { maxCostUsd: 1 } });

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
    const run = env.enqueue('Look around');

    await env.runOnce(worker(env));

    expect(env.run(run.id)).toMatchObject({ status: 'COMPLETED', usage: { unpricedCalls: 2 } });
    expect(env.ofType(run.id, 'budget.exhausted')).toEqual([]);
    expect(requestBodies(env, run.id).every((body) => body.max_output_tokens === 4096)).toBe(true);
  });
});

describe('the price of a request is the largest price of the chain it may fall back through', () => {
  const member = (model: string, billed: { billing: string; provider?: string; upstream: string } | undefined) => ({ model, counter: 'c', capabilities: {} as never, ...(billed === undefined ? {} : { billed }) });
  const table = definePriceTable([
    { provider: 'p', model: 'cheap', effectiveFrom: '2026-01-01', inputPerMTok: 1, outputPerMTok: 2, currency: 'USD' },
    { provider: 'p', model: 'dear', effectiveFrom: '2026-01-01', inputPerMTok: 0.5, cacheWritePerMTok: 4, outputPerMTok: 9, currency: 'USD' },
  ]);
  const at = Date.parse('2026-06-01T00:00:00Z');

  it('takes the larger input price (cache write included) and the larger output price over the members', () => {
    const chain = [member('a', { billing: 'metered', provider: 'p', upstream: 'cheap' }), member('b', { billing: 'metered', provider: 'p', upstream: 'dear' }), member('c', { billing: 'local', upstream: 'x' })];
    expect(chainPrice(chain, table, at)).toEqual({ inUnits: 4_000_000_000n, outUnits: 9_000_000_000n });
  });

  it.each([
    ['a member with no price entry', member('b', { billing: 'metered', provider: 'p', upstream: 'unknown' })],
    ['a member billed by a plan', member('b', { billing: 'plan', provider: 'p', upstream: 'cheap' })],
    ['a member whose billing is unknown', member('b', { billing: 'unknown', provider: 'p', upstream: 'cheap' })],
    ['a member the listing gives no billing for', member('b', undefined)],
    ['a price entry that is not yet in force', member('b', { billing: 'metered', provider: 'p', upstream: 'later' })],
  ])('has no price when the chain holds %s', (_label, unpriced) => {
    const chain = [member('a', { billing: 'metered', provider: 'p', upstream: 'cheap' }), unpriced];
    expect(chainPrice(chain, definePriceTable([...table, { provider: 'p', model: 'later', effectiveFrom: '2027-01-01', inputPerMTok: 1, outputPerMTok: 1, currency: 'USD' }]), at)).toBeUndefined();
  });
});
