import { describe, expect, it } from 'vitest';
import { expectSchema, startService } from './helpers.ts';
import { RUN_PINS } from '../memory/reflection-fixture.ts';

type Settling = {
  enqueue(runId: string): boolean;
  begin(runId: string): unknown;
  complete(input: Record<string, unknown>): unknown;
  fail(runId: string, reason: string, charge: Record<string, unknown>): unknown;
};

type ServiceEnv = Awaited<ReturnType<typeof startService>>;

const endRun = async (env: ServiceEnv, runId: string): Promise<void> => {
  const claim = env.store.claim('w-reflection-api');
  if (claim === null || claim.runId !== runId) throw new Error(`run ${runId} could not be claimed`);
  expect(env.store.append(claim, [{ type: 'run.started', attempt: claim.attempt, now: 0, pins: RUN_PINS }]).kind).toBe('ok');
  expect((await env.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
};

describe('the last reflection job of a folder', () => {
  it('answers null while no job exists for the folder', async () => {
    const env = await startService({ fakeTimers: true });
    const session = await env.createSession();
    const answer = await env.http('GET', `/v1/reflection?project=${encodeURIComponent(session.cwd)}`);
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({ job: null });
    expectSchema('ReflectionResponse', answer.json);
  });

  it('answers the job with the reason and the dropped candidates', async () => {
    const env = await startService({ fakeTimers: true });
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const jobs = env.store.reflection as unknown as Settling;
    jobs.enqueue(run.id);
    jobs.begin(run.id);
    const dropped = [{ ordinal: 0, text: 'unbound note', cause: 'evidence', reason: 'src/x.ts was not read or written in this run' }];
    jobs.complete({ runId: run.id, charge: null, candidates: [], dropped, reason: 'every candidate the model proposed was dropped' });
    const answer = await env.http('GET', `/v1/reflection?project=${encodeURIComponent(session.cwd)}`);
    expect(answer.status).toBe(200);
    expect(answer.json.job).toMatchObject({ runId: run.id, state: 'done', attempts: 1, reason: 'every candidate the model proposed was dropped', dropped });
    expectSchema('ReflectionResponse', answer.json);
  });

  it('answers the job and the charge of one run, with the detail of the billed call', async () => {
    const env = await startService({ fakeTimers: true });
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const none = await env.http('GET', `/v1/runs/${run.id}/reflection`);
    expect(none.status).toBe(200);
    expect(none.json).toEqual({ job: null, charges: [], queuedAhead: 0 });
    expectSchema('RunReflection', none.json);

    const jobs = env.store.reflection as unknown as Settling;
    const other = await env.createRun(session.id);
    jobs.enqueue(other.id);
    env.clock.advance(5);
    jobs.enqueue(run.id);
    const queued = await env.http('GET', `/v1/runs/${run.id}/reflection`);
    expect(queued.json).toMatchObject({ job: { state: 'pending' }, queuedAhead: 1 });
    expectSchema('RunReflection', queued.json);
    await endRun(env, run.id);
    jobs.begin(run.id);
    const detail = { responseId: 'resp_reflection', cachedInputTokens: 40, cost: { amount: 0.5, units: '500000000000000', currency: 'USD', priceVersion: '2026-01-01' }, timing: { firstEventMs: 3, durationMs: 9 } };
    jobs.complete({
      runId: run.id,
      charge: { runId: run.id, charged: { type: 'usage.charged', purpose: 'reflection', inputTokens: 100, outputTokens: 20, totalTokens: 120, ...detail } },
      candidates: [],
    });
    const settled = await env.http('GET', `/v1/runs/${run.id}/reflection`);
    expect(settled.json.job).toMatchObject({ runId: run.id, state: 'done' });
    expect(settled.json.charges).toMatchObject([{ purpose: 'reflection', runId: run.id, project: session.cwd, model: 'fm', totalTokens: 120, detail }]);

    const retried = await env.http('GET', `/v1/runs/${run.id}/reflection`);
    expect(retried.json.charges.map((entry: { totalTokens: number }) => entry.totalTokens)).toEqual([120]);
    expectSchema('RunReflection', retried.json);
    expectSchema('RunReflection', settled.json);
  });

  it('shows the charge of a reflection call that failed after it used tokens, and of the attempt that ended the job failed', async () => {
    const env = await startService({ fakeTimers: true });
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const jobs = env.store.reflection as unknown as Settling;
    jobs.enqueue(run.id);
    await endRun(env, run.id);

    jobs.begin(run.id);
    const failedAttempt = { runId: run.id, charged: { type: 'usage.charged' as const, purpose: 'reflection' as const, inputTokens: 50, outputTokens: 5, totalTokens: 55 } };
    env.store.chargeEndedRun(failedAttempt);

    jobs.begin(run.id);
    const lastAttempt = { runId: run.id, charged: { type: 'usage.charged' as const, purpose: 'reflection' as const, inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
    jobs.fail(run.id, 'the reflection call of run failed: overloaded', lastAttempt);

    const view = await env.http('GET', `/v1/runs/${run.id}/reflection`);
    expect(view.json.job).toMatchObject({ runId: run.id, state: 'failed', attempts: 2, reason: 'the reflection call of run failed: overloaded' });
    expect(view.json.charges.map((entry: { totalTokens: number }) => entry.totalTokens)).toEqual([55, 120]);
    expect(view.json.charges).toMatchObject([{ purpose: 'reflection', runId: run.id, model: 'fm' }, { purpose: 'reflection', runId: run.id, model: 'fm' }]);
    expectSchema('RunReflection', view.json);
  });

  it('requires an absolute project', async () => {
    const env = await startService({ fakeTimers: true });
    expect((await env.http('GET', '/v1/reflection')).status).toBe(400);
    expect((await env.http('GET', '/v1/reflection?project=relative/dir')).status).toBe(400);
  });
});
