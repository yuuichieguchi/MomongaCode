import { describe, expect, it } from 'vitest';
import { mutableRole } from '../shared/mutable-role.ts';
import { expectError, expectSchema, startService } from './helpers.ts';
import type { ServiceEnv } from './helpers.ts';

const endedRun = async (env: ServiceEnv, sessionId: string, status: 'FAILED' | 'COMPLETED') => {
  const run = await env.createRun(sessionId);
  const claim = env.claimRun(run.id);
  expect((await env.store.transition(claim, ['RUNNING'], status)).kind).toBe('ok');
  return run;
};

describe('POST /v1/runs/:id/reflection', () => {
  it('queues the reflection of a run that has ended and answers 202 with the view that GET then shows', async () => {
    const env = await startService({ fakeTimers: true });
    const session = await env.createSession();
    const run = await endedRun(env, session.id, 'FAILED');
    expect(env.store.reflection.get(run.id)).toBeUndefined();

    const asked = await env.http('POST', `/v1/runs/${run.id}/reflection`);

    expect(asked.status).toBe(202);
    expectSchema('RunReflection', asked.json);
    expect(asked.json).toMatchObject({ job: { runId: run.id, state: 'pending', attempts: 0 }, charges: [], queuedAhead: 0 });
    expect((await env.http('GET', `/v1/runs/${run.id}/reflection`)).json).toEqual(asked.json);
    expect(env.store.reflection.next()?.runId).toBe(run.id);
  });

  it('answers the job that already exists and queues no second one', async () => {
    const env = await startService({ fakeTimers: true });
    const session = await env.createSession();
    const run = await endedRun(env, session.id, 'COMPLETED');
    const queuedByTheStore = (await env.http('GET', `/v1/runs/${run.id}/reflection`)).json;
    expect(queuedByTheStore.job).toMatchObject({ state: 'pending' });

    const asked = await env.http('POST', `/v1/runs/${run.id}/reflection`);

    expect(asked.status).toBe(202);
    expect(asked.json).toEqual(queuedByTheStore);
  });

  it('answers 404 for an unknown run and 409 run_active for a run that has not ended', async () => {
    const env = await startService({ fakeTimers: true });
    const session = await env.createSession();
    const open = await env.createRun(session.id);

    expectError(await env.http('POST', '/v1/runs/nope/reflection'), 404, 'not_found');
    expectError(await env.http('POST', `/v1/runs/${open.id}/reflection`), 409, 'run_active');
    expect(env.store.reflection.get(open.id)).toBeUndefined();
  });

  it('is answered moved by a retiring runtime, since a reflection starts a model call', async () => {
    const state = mutableRole('serving');
    const env = await startService({ fakeTimers: true, role: state.port });
    const session = await env.createSession();
    const run = await endedRun(env, session.id, 'FAILED');
    state.set('retiring');
    env.service.applyRole();

    expectError(await env.http('POST', `/v1/runs/${run.id}/reflection`), 503, 'moved');
    expect(env.store.reflection.get(run.id)).toBeUndefined();
  });
});
