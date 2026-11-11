import { describe, expect, it } from 'vitest';
import { startService } from './helpers.ts';
import type { JsonResponse, ServiceEnv } from './helpers.ts';

const SESSION_ENV = { PATH: '/usr/bin:/bin', LANG: 'C' };

type PersonRoute = { method: string; target: (env: ServiceEnv) => string; body?: (env: ServiceEnv) => unknown };

const PERSON_ROUTES: readonly PersonRoute[] = [
  { method: 'POST', target: () => '/v1/approvals/a1', body: () => ({ decision: 'allow' }) },
  { method: 'PUT', target: () => '/v1/trust', body: (env) => ({ path: env.layout.project, decision: 'trusted' }) },
  { method: 'DELETE', target: (env) => `/v1/trust?path=${encodeURIComponent(env.layout.project)}` },
  { method: 'POST', target: () => '/v1/rules', body: () => ({}) },
  { method: 'POST', target: () => '/v1/rules/r1/retire', body: () => ({}) },
  { method: 'PUT', target: () => '/v1/policy/verdicts/f1', body: () => ({}) },
  { method: 'POST', target: () => '/v1/memories', body: () => ({}) },
  { method: 'DELETE', target: () => '/v1/memories/m1' },
  { method: 'POST', target: () => '/v1/memories/m1/accept', body: () => ({}) },
  { method: 'POST', target: () => '/v1/memories/m1/reject', body: () => ({}) },
  { method: 'POST', target: () => '/v1/memories/m1/promote', body: () => ({}) },
  { method: 'POST', target: () => '/v1/memories/m1/restore', body: () => ({}) },
  { method: 'POST', target: () => '/v1/guidelines', body: () => ({}) },
  { method: 'POST', target: () => '/v1/guidelines/1/rollback', body: () => ({}) },
  { method: 'POST', target: () => '/v1/sessions/s1/user-shell', body: () => ({}) },
  { method: 'DELETE', target: () => '/v1/sessions/s1/user-shell' },
  { method: 'POST', target: () => '/v1/elicitations/e1', body: () => ({}) },
  { method: 'POST', target: () => '/v1/sessions/s1/mcp/servers/fx/authorization', body: () => ({}) },
  { method: 'DELETE', target: () => '/v1/sessions/s1/mcp/servers/fx/authorization' },
  { method: 'POST', target: () => '/v1/mcp/servers/fx/authorization', body: () => ({}) },
  { method: 'DELETE', target: () => '/v1/mcp/servers/fx/authorization' },
  { method: 'POST', target: () => '/v1/markers/fx/ignore' },
];

const send = (env: ServiceEnv, route: PersonRoute, person: boolean): Promise<JsonResponse> =>
  env.http(route.method, route.target(env), { ...(route.body === undefined ? {} : { body: route.body(env) }), person });

const expectPersonOnly = (response: JsonResponse): void => {
  expect({ status: response.status, type: response.json?.error?.type, code: response.json?.error?.code }).toEqual({ status: 403, type: 'forbidden', code: 'person_only' });
};

describe('the routes that act for the person', () => {
  it.each(PERSON_ROUTES)('$method of a person route answers 403 person_only without the capability and is served with it', async (route) => {
    const env = await startService({ fakeTimers: true });
    expectPersonOnly(await send(env, route, false));
    expect((await send(env, route, true)).status).not.toBe(403);
  });

  it('a wrong capability is refused like a missing one', async () => {
    const env = await startService({ fakeTimers: true });
    expectPersonOnly(await env.http('PUT', '/v1/trust', { body: { path: env.layout.project, decision: 'trusted' }, person: false, headers: { 'momonga-person-capability': '0'.repeat(32) } }));
  });

  it('reads stay open without the capability', async () => {
    const env = await startService({ fakeTimers: true });
    for (const target of ['/v1/health', `/v1/trust?path=${encodeURIComponent(env.layout.project)}`, '/v1/memories', '/v1/guidelines', '/v1/sessions']) {
      expect((await env.http('GET', target, { person: false })).status).toBe(200);
    }
  });

  it('creating and changing a session are refused without the capability and served with it', async () => {
    const env = await startService({ fakeTimers: true });
    const create = (person: boolean): Promise<JsonResponse> => env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: SESSION_ENV }, person });
    expectPersonOnly(await create(false));
    const created = await create(true);
    expect(created.status).toBe(201);
    const id: string = created.json.session.id;
    const patch = (body: Record<string, unknown>, person: boolean): Promise<JsonResponse> =>
      env.http('PATCH', `/v1/sessions/${id}`, { body, person, contentType: 'application/merge-patch+json' });
    const servers = { mcpServers: { fx: { type: 'stdio', command: 'node', args: ['server.js'] } } };
    expectPersonOnly(await patch(servers, false));
    expectPersonOnly(await patch({ permissionMode: 'plan' }, false));
    expect((await patch(servers, true)).status).toBe(200);
    expect((await patch({ permissionMode: 'plan' }, true)).status).toBe(200);
  });

  it('a session that may bypass is refused without the capability, whatever the body says, and created with it', async () => {
    const env = await startService({ fakeTimers: true });
    const create = (body: Record<string, unknown>, person: boolean): Promise<JsonResponse> =>
      env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: SESSION_ENV, ...body }, person });
    expectPersonOnly(await create({ bypassAllowed: true }, false));
    expectPersonOnly(await create({ bypassAllowed: true, permissionMode: 'bypassPermissions' }, false));
    expectPersonOnly(await create({}, false));
    const allowed = await create({ bypassAllowed: true }, true);
    expect(allowed.status).toBe(201);
    const id: string = allowed.json.session.id;
    expectPersonOnly(await env.http('PATCH', `/v1/sessions/${id}`, { body: { permissionMode: 'bypassPermissions' }, person: false, contentType: 'application/merge-patch+json' }));
    expect((await env.http('PATCH', `/v1/sessions/${id}`, { body: { permissionMode: 'bypassPermissions' }, person: true, contentType: 'application/merge-patch+json' })).status).toBe(200);
  });
});
