import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { McpAuthorizationView, McpServerView } from '@momonga/protocol';
import { START_MS, expectError, startService, toolCallPayload } from './helpers.ts';
import type { ServiceEnv } from './helpers.ts';

const REQUESTS = [
  { key: 'who', mode: 'form' as const, message: 'Who?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { key: 'link', mode: 'url' as const, message: 'Connect', url: 'https://example.test/c' },
];

const waitingForInput = async (env: ServiceEnv) => {
  const session = await env.createSession();
  const run = await env.createRun(session.id);
  const claim = env.claimRun(run.id);
  env.append(claim, [toolCallPayload('call_1', path.join(env.layout.projectReal, 'a.txt'))]);
  const requested = await env.store.requestElicitation(claim, { callId: 'call_1', expiresAt: START_MS + 60_000, server: 'remote', requests: REQUESTS });
  if (requested.kind !== 'ok') throw new Error('expected an elicitation');
  expect((await env.store.release(claim, 'WAITING_HUMAN')).kind).toBe('ok');
  return { run, id: requested.approval.id };
};

describe('elicitation routes', () => {
  it('lists the pending elicitation of a run with the server and its requests, apart from approvals', async () => {
    const env = await startService();
    const { run, id } = await waitingForInput(env);
    const listed = await env.http('GET', `/v1/runs/${run.id}/elicitations`);
    expect(listed.json.elicitations).toMatchObject([{ id, runId: run.id, callId: 'call_1', status: 'pending', server: 'remote', requests: REQUESTS }]);
    expect((await env.http('GET', `/v1/runs/${run.id}/approvals`)).json.approvals).toEqual([]);
    expect((await env.http('GET', `/v1/elicitations/${id}`)).json.elicitation.id).toBe(id);
    expectError(await env.http('GET', `/v1/approvals/${id}`), 404, 'not_found');
  });

  it('records the answers of the person, requeues the run and emits tool.elicitation.resolved', async () => {
    const env = await startService();
    const { run, id } = await waitingForInput(env);
    const responses = { who: { action: 'accept', content: { name: 'Ada' } }, link: { action: 'decline' } };
    const response = await env.http('POST', `/v1/elicitations/${id}`, { body: { responses } });
    expect(response.status).toBe(200);
    expect(response.json.run.status).toBe('QUEUED');
    expect(env.ofType(run.id, 'tool.elicitation.resolved')).toEqual([expect.objectContaining({ inputId: id, responses })]);
    expectError(await env.http('POST', `/v1/elicitations/${id}`, { body: { responses } }), 409, 'approval_not_pending');
  });

  it.each([
    ['content that breaks the requested schema', { who: { action: 'accept', content: { name: 3 } }, link: { action: 'accept' } }],
    ['a missing answer', { who: { action: 'decline' } }],
    ['an unknown key', { who: { action: 'decline' }, link: { action: 'cancel' }, other: { action: 'cancel' } }],
  ])('rejects %s with 400 and leaves the request pending', async (_name, responses) => {
    const env = await startService();
    const { run, id } = await waitingForInput(env);
    expectError(await env.http('POST', `/v1/elicitations/${id}`, { body: { responses } }), 400, 'invalid_request');
    expect((await env.getRun(run.id)).status).toBe('WAITING_HUMAN');
    expect(env.ofType(run.id, 'tool.elicitation.resolved')).toEqual([]);
  });

  it('answers an unknown elicitation with 404', async () => {
    const env = await startService();
    expectError(await env.http('POST', '/v1/elicitations/missing', { body: { responses: {} } }), 404, 'not_found');
  });
});

describe('MCP server routes', () => {
  const view: McpAuthorizationView = { server: 'remote', status: 'awaiting_user', startedAt: 1, expiresAt: 2, url: 'https://auth.example.test/authorize?x=1' };
  const server: McpServerView = { name: 'remote', scope: 'user', transport: 'http', url: 'https://mcp.example.test/mcp', auth: 'required' };

  it('lists servers with their auth state and starts, reads and cancels an authorization', async () => {
    const calls: string[] = [];
    const env = await startService({
      mcp: {
        servers: (sessionId) => Promise.resolve(sessionId === 'ghost' ? [] : [server]),
        startAuthorization: (sessionId, name) => {
          calls.push(`start ${sessionId} ${name}`);
          return Promise.resolve(view);
        },
        authorization: (_sessionId, name) => (name === 'remote' ? view : undefined),
        cancelAuthorization: (_sessionId, name) => name === 'remote',
      },
    });
    const session = await env.createSession();
    expect((await env.http('GET', `/v1/sessions/${session.id}/mcp/servers`)).json.servers).toEqual([server]);

    const started = await env.http('POST', `/v1/sessions/${session.id}/mcp/servers/remote/authorization`);
    expect(started.status).toBe(202);
    expect(started.json.authorization).toEqual(view);
    expect(calls).toEqual([`start ${session.id} remote`]);
    expect((await env.http('GET', `/v1/sessions/${session.id}/mcp/servers/remote/authorization`)).json.authorization).toEqual(view);
    expectError(await env.http('GET', `/v1/sessions/${session.id}/mcp/servers/other/authorization`), 404, 'not_found');
    expect((await env.http('DELETE', `/v1/sessions/${session.id}/mcp/servers/remote/authorization`)).status).toBe(204);
    expectError(await env.http('DELETE', `/v1/sessions/${session.id}/mcp/servers/other/authorization`), 404, 'not_found');
  });
});
