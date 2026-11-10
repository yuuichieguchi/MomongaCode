import { describe, expect, it } from 'vitest';
import { attachWorkerKit, expectError, startService } from './helpers.ts';

describe('POST /v1/sessions/:id/compact', () => {
  it('starts one run of the session that carries the focus text and ends COMPLETED without a model step', async () => {
    const env = await startService();
    const kit = attachWorkerKit(env);
    const session = await env.createSession();

    const response = await env.http('POST', `/v1/sessions/${session.id}/compact`, { body: { instructions: 'keep the test names' } });

    expect(response.status).toBe(202);
    const run = response.json.run;
    expect(run.sessionId).toBe(session.id);
    expect(env.ofType(run.id, 'user.message').map((event) => event.text)).toEqual(['/compact keep the test names']);
    expect(await kit.runOnce(kit.worker())).toBe('yielded');
    expect((await env.getRun(run.id)).status).toBe('COMPLETED');
    expect(kit.gateway.streams).toEqual([]);
    expect(env.ofType(run.id, 'notice').map((event) => event.message)).toContain('Nothing to compact.');
  });

  it('accepts an empty body', async () => {
    const env = await startService();
    const session = await env.createSession();
    const response = await env.http('POST', `/v1/sessions/${session.id}/compact`, { body: {} });
    expect(response.status).toBe(202);
    expect(env.ofType(response.json.run.id, 'user.message').map((event) => event.text)).toEqual(['/compact']);
  });

  it('is refused with 409 run_active while a run of the session is open', async () => {
    const env = await startService();
    const session = await env.createSession();
    await env.createRun(session.id);
    expectError(await env.http('POST', `/v1/sessions/${session.id}/compact`, { body: {} }), 409, 'run_active');
    const second = await startService();
    const other = await second.createSession();
    expect((await second.http('POST', `/v1/sessions/${other.id}/compact`, { body: {} })).status).toBe(202);
    expectError(await second.http('POST', `/v1/sessions/${other.id}/compact`, { body: {} }), 409, 'run_active');
  });

  it('answers 404 for an unknown session and 400 for a body outside the schema', async () => {
    const env = await startService();
    const session = await env.createSession();
    expectError(await env.http('POST', '/v1/sessions/nope/compact', { body: {} }), 404, 'not_found');
    expectError(await env.http('POST', `/v1/sessions/${session.id}/compact`, { body: { instructions: '' } }), 400, 'invalid_request');
    expectError(await env.http('POST', `/v1/sessions/${session.id}/compact`, { body: { input: 'x' } }), 400, 'invalid_request');
  });
});
