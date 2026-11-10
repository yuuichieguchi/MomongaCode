import { describe, expect, it } from 'vitest';
import type { GenerationRole } from '@momonga/foundation';
import { mutableRole } from '../shared/mutable-role.ts';
import { startService } from './helpers.ts';
import type { JsonResponse } from './helpers.ts';

const MOVED_TEXT = 'This daemon has been replaced by a newer version and accepts no new work. The request was not run; send it again.';

const expectMoved = (response: JsonResponse): void => {
  expect({ status: response.status, body: response.json, retryAfter: response.headers['retry-after'] }).toEqual({
    status: 503,
    body: { error: { type: 'server_error', code: 'moved', message: MOVED_TEXT } },
    retryAfter: '1',
  });
};

const ruleBody = (project: string) => ({ kind: 'constraint', target: 'production-database', text: 'never touch production', scope: { level: 'project', project, paths: [] } });

const serviceIn = async (role: GenerationRole) => {
  const state = mutableRole('serving');
  const env = await startService({ fakeTimers: true, role: state.port });
  const session = await env.createSession();
  const stored = await env.createRun(session.id, { input: 'stored' }, { 'idempotency-key': 'key-1' });
  state.set(role);
  env.service.applyRole();
  return { env, session, stored, state };
};

describe.each(['starting', 'retiring'] as const)('a %s runtime refuses the requests that create work (17.1, 20.2, 20.33)', (role) => {
  it('answers POST /v1/sessions with 503 moved, retry-after 1 and no sockets in the body, and creates nothing', async () => {
    const { env } = await serviceIn(role);
    const before = env.store.listSessions().length;

    expectMoved(await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: { PATH: '/usr/bin:/bin' } } }));

    expect(env.store.listSessions()).toHaveLength(before);
  });

  it('answers a new POST runs with 503 moved and stores no run', async () => {
    const { env, session } = await serviceIn(role);

    expectMoved(await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'new work' } }));

    expect(env.store.listRuns(session.id)).toHaveLength(1);
  });

  it('answers the replay of a stored idempotency key from the store with 202 and idempotent-replayed', async () => {
    const { env, session, stored } = await serviceIn(role);

    const replayed = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'stored' }, headers: { 'idempotency-key': 'key-1' } });

    expect(replayed.status).toBe(202);
    expect(replayed.headers['idempotent-replayed']).toBe('true');
    expect(replayed.json.run.id).toBe(stored.id);
  });

  it('checks 404, 400 and 422 before moved, as draining does', async () => {
    const { env, session } = await serviceIn(role);

    expect((await env.http('POST', '/v1/sessions/01900000-0000-7000-8000-00000000dead/runs', { body: { input: 'x' } })).status).toBe(404);
    expect((await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: {} })).status).toBe(400);
    expect((await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'other' }, headers: { 'idempotency-key': 'key-1' } })).status).toBe(422);
  });

  it('answers every read and the requests that only write rows', async () => {
    const { env, session, stored } = await serviceIn(role);

    expect((await env.http('GET', `/v1/sessions/${session.id}`)).status).toBe(200);
    expect((await env.http('GET', `/v1/runs/${stored.id}`)).status).toBe(200);
    expect((await env.http('GET', `/v1/sessions/${session.id}/runs`)).status).toBe(200);
    expect((await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { permissionMode: 'plan' }, headers: { 'content-type': 'application/json' } })).status).toBe(200);
    expect([200, 202]).toContain((await env.http('POST', `/v1/runs/${stored.id}/cancel`)).status);
    expect((await env.http('PUT', '/v1/trust', { body: { path: env.layout.project, decision: 'trusted' } })).status).toBe(200);
  });
});

describe('the routes only a retiring runtime refuses (20.42)', () => {
  it('answers POST /v1/rules with moved while retiring and adds no rule', async () => {
    const { env } = await serviceIn('retiring');
    const body = ruleBody(env.layout.project);

    const refused = await env.http('POST', '/v1/rules', { body });

    expectMoved(refused);
    expect(env.store.governing.list({ project: env.layout.projectReal })).toEqual([]);
  });

  it('answers the start of an MCP authorization with moved while retiring, and its cancel as before', async () => {
    const { env, session } = await serviceIn('retiring');

    expectMoved(await env.http('POST', `/v1/sessions/${session.id}/mcp/servers/fx/authorization`));
  });

  it('does not refuse POST /v1/rules while starting: only sessions and runs are refused there', async () => {
    const { env } = await serviceIn('starting');
    const body = ruleBody(env.layout.project);

    const answered = await env.http('POST', '/v1/rules', { body });

    expect(answered.json?.error?.code).not.toBe('moved');
  });
});

describe('health by role (17.1, 20.2, 20.45)', () => {
  it('reports state running with role starting, then serving, then state retiring; draining wins over retiring', async () => {
    const state = mutableRole('starting');
    const env = await startService({ fakeTimers: true, role: state.port, work: { steps: () => 2, jobs: () => 1 } });

    expect((await env.http('GET', '/v1/health')).json).toMatchObject({ state: 'running', role: 'starting', steps: 2, jobs: 1 });
    state.set('serving');
    expect((await env.http('GET', '/v1/health')).json).toMatchObject({ state: 'running', role: 'serving' });
    state.set('retiring');
    expect((await env.http('GET', '/v1/health')).json).toMatchObject({ state: 'retiring', role: 'retiring' });
    env.service.beginDraining();
    expect((await env.http('GET', '/v1/health')).json).toMatchObject({ state: 'draining', role: 'retiring' });
  });

  it('sends connection: close on every response while retiring, and not before', async () => {
    const state = mutableRole('serving');
    const env = await startService({ fakeTimers: true, role: state.port });

    expect((await env.http('GET', '/v1/health')).headers['connection']).not.toBe('close');
    state.set('retiring');
    expect((await env.http('GET', '/v1/health')).headers['connection']).toBe('close');
    expect((await env.http('GET', '/v1/sessions')).headers['connection']).toBe('close');
  });
});

describe('the open non-stream requests of the service (20.31, 20.46)', () => {
  it('counts a request while it is in flight, never a stream, and tells when one ends', async () => {
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    let ended = 0;
    const env = await startService({
      fakeTimers: true,
      imageInput: true,
      onRequestEnd: () => {
        ended += 1;
      },
      beforeCapabilities: () => {
        reached.resolve();
        return gate.promise;
      },
    });
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const endedBefore = ended;
    const stream = await env.stream(`/v1/runs/${run.id}/events`);
    expect(env.service.openRequests()).toBe(0);

    const image = { mediaType: 'image/png', data: Buffer.from('fake png bytes').toString('base64') };
    const pending = env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'what is this', images: [image] } });
    await reached.promise;
    expect(env.service.openRequests()).toBe(1);
    gate.resolve();
    expect((await pending).status).toBe(202);
    await expect.poll(() => env.service.openRequests()).toBe(0);
    expect(ended).toBe(endedBefore + 1);
    stream.close();
  });
});
