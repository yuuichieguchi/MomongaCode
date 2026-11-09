import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPTIONS, START_MS, expectError, requestManualApproval, startService, toolCallPayload } from './helpers.ts';
import type { JsonResponse } from './helpers.ts';

const expectDraining = (response: JsonResponse): void => {
  expect({ status: response.status, body: response.json, retryAfter: response.headers['retry-after'] }).toEqual({
    status: 503,
    body: { error: { type: 'server_error', code: 'draining', message: expect.any(String) } },
    retryAfter: '1',
  });
};

describe('draining while admission checks are pending (fake timers)', () => {
  it('no longer routes /v1/drain-if-idle', async () => {
    const env = await startService({ fakeTimers: true });
    expect((await env.http('POST', '/v1/drain-if-idle')).status).toBe(404);
    expect((await env.http('GET', '/v1/health')).json).toMatchObject({ state: 'running' });
  });

  it('refuses a run whose admission checks were still pending when draining began, and stores no run', async () => {
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const env = await startService({
      fakeTimers: true,
      imageInput: true,
      beforeCapabilities: () => {
        reached.resolve();
        return gate.promise;
      },
    });
    const session = await env.createSession();
    const image = { mediaType: 'image/png', data: Buffer.from('fake png bytes').toString('base64') };

    const pending = env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'what is this', images: [image] } });
    await reached.promise;
    env.service.beginDraining();
    gate.resolve();

    expectDraining(await pending);
    expect(env.store.listRuns(session.id)).toEqual([]);
  });
});

describe('draining (fake timers)', () => {
  it('POST /v1/sessions answers 503 draining with retry-after 1', async () => {
    const env = await startService({ fakeTimers: true });
    env.service.beginDraining();
    expectDraining(await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: { PATH: '/usr/bin:/bin' } } }));
    expect(env.store.listSessions()).toEqual([]);
    expect(env.ports.settingsCalls).toEqual([]);
  });

  it('POST runs answers 503 draining with retry-after 1 for a new run', async () => {
    const env = await startService({ fakeTimers: true });
    const session = await env.createSession();
    env.service.beginDraining();
    expectDraining(await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'hello' } }));
    expect(env.store.listRuns(session.id)).toEqual([]);
  });

  it('replays an existing keyed run with 202 and idempotent-replayed', async () => {
    const env = await startService({ fakeTimers: true });
    const session = await env.createSession();
    const body = { input: 'keyed', timeoutMs: 5000 };
    const headers = { 'idempotency-key': 'drain-1' };
    const created = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body, headers });
    expect(created.status).toBe(202);
    env.service.beginDraining();

    const replayed = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body, headers });

    expect(replayed.status).toBe(202);
    expect(replayed.headers['idempotent-replayed']).toBe('true');
    expect(replayed.headers['location']).toBe(`/v1/runs/${created.json.run.id}`);
    expect(replayed.json.run.id).toBe(created.json.run.id);
    expect(env.store.listRuns(session.id).map((run) => run.id)).toEqual([created.json.run.id]);
  });

  it('answers 422 for the same key with a different body', async () => {
    const env = await startService({ fakeTimers: true });
    const session = await env.createSession();
    const headers = { 'idempotency-key': 'drain-2' };
    expect((await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'first' }, headers })).status).toBe(202);
    env.service.beginDraining();
    expectError(await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'second' }, headers }), 422, 'idempotency_key_reused');
    expect(env.store.listRuns(session.id)).toHaveLength(1);
  });

  it('answers 503 with retry-after 1 for a keyed request whose key is unknown', async () => {
    const env = await startService({ fakeTimers: true });
    const session = await env.createSession();
    await env.createRun(session.id, { input: 'earlier' }, { 'idempotency-key': 'known-1' });
    env.service.beginDraining();
    expectDraining(await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'new' }, headers: { 'idempotency-key': 'unknown-1' } }));
    expect(env.store.listRuns(session.id)).toHaveLength(1);
  });

  it('answers 404 for an unknown session before 503, with and without a key', async () => {
    const env = await startService({ fakeTimers: true });
    env.service.beginDraining();
    expectError(await env.http('POST', '/v1/sessions/ses_missing/runs', { body: { input: 'x' } }), 404, 'not_found');
    expectError(await env.http('POST', '/v1/sessions/ses_missing/runs', { body: { input: 'x' }, headers: { 'idempotency-key': 'k-404' } }), 404, 'not_found');
  });

  it('answers 400 for an invalid body or Idempotency-Key before 503', async () => {
    const env = await startService({ fakeTimers: true });
    const session = await env.createSession();
    env.service.beginDraining();
    const target = `/v1/sessions/${session.id}/runs`;
    expectError(await env.http('POST', target, { body: { input: 'x', extra: true } }), 400, 'invalid_request');
    expectError(await env.http('POST', target, { body: { input: 'x', extra: true }, headers: { 'idempotency-key': 'k-400' } }), 400, 'invalid_request');
    expectError(await env.http('POST', target, { body: { input: 'x' }, headers: { 'idempotency-key': '"unterminated' } }), 400, 'invalid_request');
  });

  it('GET, SSE, PATCH, cancel, approvals and trust keep working', async () => {
    const env = await startService({ fakeTimers: true });
    const session = await env.createSession();
    const approvalRun = await env.createRun(session.id, { input: 'needs approval' });
    const cancelRun = await env.createRun(session.id, { input: 'to cancel' });
    const claim = env.claimRun(approvalRun.id);
    env.append(claim, [toolCallPayload('call_1', path.join(env.layout.projectReal, 'a.txt'))]);
    const approvalId = await requestManualApproval(env, claim, 'call_1');
    expect((await env.store.release(claim, 'WAITING_HUMAN')).kind).toBe('ok');

    env.service.beginDraining();

    expect((await env.http('GET', `/v1/sessions/${session.id}`)).status).toBe(200);
    expect((await env.http('GET', '/v1/sessions')).status).toBe(200);
    expect((await env.http('GET', `/v1/runs/${approvalRun.id}`)).status).toBe(200);
    expect((await env.http('GET', `/v1/sessions/${session.id}/runs`)).status).toBe(200);

    const stream = await env.stream(`/v1/runs/${approvalRun.id}/events`, { headers: { 'last-event-id': '0' } });
    expect(stream.status).toBe(200);
    const seen = await stream.until((event) => event.type === 'tool.permission.requested');
    expect(seen.at(-1)).toMatchObject({ type: 'tool.permission.requested', approvalId });
    stream.close();

    const patched = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { permissionMode: 'plan' } });
    expect(patched.status).toBe(200);
    expect(patched.json.session.permissionMode).toBe('plan');

    const cancelled = await env.http('POST', `/v1/runs/${cancelRun.id}/cancel`);
    expect(cancelled.status).toBe(202);
    expect(cancelled.json.run.status).toBe('CANCELLING');

    expect((await env.http('GET', `/v1/runs/${approvalRun.id}/approvals`)).json.approvals.map((approval: { id: string }) => approval.id)).toEqual([approvalId]);
    expect((await env.http('GET', `/v1/approvals/${approvalId}`)).status).toBe(200);
    const optionId = OPTIONS[0]?.optionId as string;
    const resolved = await env.http('POST', `/v1/approvals/${approvalId}`, { body: { optionId } });
    expect(resolved.status).toBe(200);
    expect(resolved.json.approval.status).not.toBe('pending');

    const put = await env.http('PUT', '/v1/trust', { body: { path: env.layout.project, decision: 'trusted' } });
    expect(put.status).toBe(200);
    const read = await env.http('GET', `/v1/trust?path=${encodeURIComponent(env.layout.project)}`);
    expect(read.json).toEqual({ trust: { path: env.layout.projectReal, decision: 'trusted' } });
    expect((await env.http('DELETE', `/v1/trust?path=${encodeURIComponent(env.layout.project)}`)).status).toBe(204);
  });

  it('health reports state draining', async () => {
    const env = await startService({ fakeTimers: true });
    env.service.beginDraining();
    const health = await env.http('GET', '/v1/health');
    expect(health.status).toBe(200);
    expect(health.json.state).toBe('draining');
  });

  it('beginDraining is synchronous, idempotent and irreversible', async () => {
    const env = await startService({ fakeTimers: true });
    expect((await env.http('GET', '/v1/health')).json.state).toBe('running');

    const returned: unknown = env.service.beginDraining();
    expect(returned).toBeUndefined();
    expectDraining(await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {} } }));

    expect(() => env.service.beginDraining()).not.toThrow();
    env.timers?.advance(60 * 60_000);
    expect((await env.http('GET', '/v1/health')).json.state).toBe('draining');
    expectDraining(await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {} } }));
  });
});
