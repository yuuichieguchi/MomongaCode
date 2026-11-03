import { describe, expect, it } from 'vitest';
import { expectSchema, startService } from './helpers.ts';

type Settling = {
  enqueue(runId: string): boolean;
  begin(runId: string): unknown;
  complete(input: Record<string, unknown>): unknown;
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

  it('requires an absolute project', async () => {
    const env = await startService({ fakeTimers: true });
    expect((await env.http('GET', '/v1/reflection')).status).toBe(400);
    expect((await env.http('GET', '/v1/reflection?project=relative/dir')).status).toBe(400);
  });
});
