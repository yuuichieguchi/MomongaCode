import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { expectSchema, startService } from './helpers.ts';

const TOTALS = { calls: 1, localCalls: 0, unpricedCalls: 0, unknownBillingCalls: 0, inputTokens: 2, outputTokens: 3, cachedInputTokens: 0, amount: 0.5, currency: 'USD', priceVersions: ['v1'], roles: {} };

const runCost = async () => ({ report: { runs: [], sessions: [], total: TOTALS }, text: 'the text report' });

const chargesOf = (store: RuntimeStore) => (store as unknown as { contextCharges: { record(input: Record<string, unknown>): unknown } }).contextCharges;

const CHARGE = { model: 'fm', inputTokens: 100, outputTokens: 20, totalTokens: 120 };

const seeded = async () => {
  const env = await startService({ runCost });
  const session = await env.createSession();
  const run = await env.createRun(session.id, { input: 'x' });
  chargesOf(env.store).record({ ...CHARGE, purpose: 'reflection', runId: run.id, project: session.cwd });
  chargesOf(env.store).record({ ...CHARGE, purpose: 'guideline', runId: null, project: '/elsewhere', inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  return { env, session, run };
};

const REFLECTION = { purpose: 'reflection', model: 'fm', inputTokens: 100, outputTokens: 20, totalTokens: 120 };
const GUIDELINE = { purpose: 'guideline', model: 'fm', inputTokens: 7, outputTokens: 3, totalTokens: 10 };

describe('GET /v1/cost with context charges', () => {
  it('reports every charge, with or without a run, in the unfiltered report', async () => {
    const { env } = await seeded();
    const response = await env.http('GET', '/v1/cost');
    expect(response.json.contextCharges).toEqual({ charges: [expect.objectContaining(REFLECTION), expect.objectContaining(GUIDELINE)], totalTokens: 130 });
    expectSchema('CostReport', response.json);
  });

  it('guards calls without a run that vanish or leak: only the unfiltered report asks the gateway to count them', async () => {
    const asked: boolean[] = [];
    const env = await startService({
      runCost: async (_runs, _signal, includeRunless) => {
        asked.push(includeRunless);
        return runCost();
      },
    });
    const session = await env.createSession();
    const run = await env.createRun(session.id, { input: 'x' });
    for (const query of ['', `?run=${run.id}`, `?session=${session.id}`, `?cwd=${encodeURIComponent(session.cwd)}`]) await env.http('GET', `/v1/cost${query}`);
    expect(asked).toEqual([true, false, false, false]);
  });

  it('narrows to the run, the session and the working directory', async () => {
    const { env, session, run } = await seeded();
    for (const query of [`run=${run.id}`, `session=${session.id}`, `cwd=${encodeURIComponent(session.cwd)}`]) {
      const response = await env.http('GET', `/v1/cost?${query}`);
      expect(response.json.contextCharges).toEqual({ charges: [expect.objectContaining(REFLECTION)], totalTokens: 120 });
    }
  });

  it('prints the charges in the text report, so a person sees spending outside a run', async () => {
    const { env } = await seeded();
    const response = await env.http('GET', '/v1/cost?format=text');
    expect(response.text).toContain('the text report');
    expect(response.text).toContain('reflection');
    expect(response.text).toContain('120');
    expect(response.text).toContain('guideline');
  });

  it('adds the charges of both purposes to the printed token total, whatever their purpose', async () => {
    const { env } = await seeded();
    const response = await env.http('GET', '/v1/cost?format=text');
    expect(response.text).toContain('context charges total: 130 tokens');
    expect(response.text).toContain('all model calls: 135 tokens (runs 5, context charges 130)');
  });
});
