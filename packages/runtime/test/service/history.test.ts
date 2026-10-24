import { describe, expect, it } from 'vitest';
import { expectError, expectSchema, startService } from './helpers.ts';

describe('run history over the API', () => {
  it('defaults history to inherit and points previousRunId at the latest run of the session', async () => {
    const env = await startService();
    const session = await env.createSession();

    const first = await env.createRun(session.id, { input: 'first' });
    const second = await env.createRun(session.id, { input: 'second' });

    expect(first).toMatchObject({ previousRunId: null, history: 'inherit' });
    expect(second).toMatchObject({ previousRunId: first.id, history: 'inherit' });
    expectSchema('RunView', second);
    expect(env.store.getRun(second.id)).toMatchObject({ previousRunId: first.id, history: 'inherit' });
  });

  it('stores history fresh when asked and returns it from GET and the list', async () => {
    const env = await startService();
    const session = await env.createSession();
    const first = await env.createRun(session.id, { input: 'first' });

    const fresh = await env.createRun(session.id, { input: 'clear', history: 'fresh' });

    expect(fresh).toMatchObject({ previousRunId: first.id, history: 'fresh' });
    expect(env.store.getRun(fresh.id)).toMatchObject({ history: 'fresh' });
    const fetched = await env.getRun(fresh.id);
    expect(fetched).toMatchObject({ previousRunId: first.id, history: 'fresh' });
    expectSchema('RunView', fetched);
    const list = await env.http('GET', `/v1/sessions/${session.id}/runs`);
    expect(list.json.runs.map((run: { history: string; previousRunId: string | null }) => [run.history, run.previousRunId])).toEqual([
      ['inherit', null],
      ['fresh', first.id],
    ]);
    for (const run of list.json.runs) expectSchema('RunView', run);
  });

  it('accepts an explicit history inherit', async () => {
    const env = await startService();
    const session = await env.createSession();
    expect(await env.createRun(session.id, { input: 'first', history: 'inherit' })).toMatchObject({ history: 'inherit' });
  });

  it('rejects an unknown history value with 400', async () => {
    const env = await startService();
    const session = await env.createSession();
    expectError(await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'x', history: 'none' } }), 400, 'invalid_request');
  });

  it('treats a reused Idempotency-Key with another history as a different request', async () => {
    const env = await startService();
    const session = await env.createSession();
    const target = `/v1/sessions/${session.id}/runs`;
    const headers = { 'idempotency-key': 'history-1' };

    const first = await env.http('POST', target, { body: { input: 'x' }, headers });
    const fresh = await env.http('POST', target, { body: { input: 'x', history: 'fresh' }, headers });

    expect(first.status).toBe(202);
    expect(first.json.run.history).toBe('inherit');
    expectError(fresh, 422, 'idempotency_key_reused');
  });
});
