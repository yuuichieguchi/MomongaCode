import { describe, expect, it } from 'vitest';
import { expectError, startService } from './helpers.ts';

const STDIO = { type: 'stdio', command: 'editor-server', args: ['--stdio'], env: { TOKEN: 'literal' } };
const HTTP = { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer literal' } };

describe('session MCP servers', () => {
  it('stores the servers given at session creation and keeps them out of the session view', async () => {
    const env = await startService();
    const session = await env.createSession({ mcpServers: { editor: STDIO, docs: HTTP } });

    expect(env.store.getSession(session.id)?.mcpServers).toEqual({ editor: STDIO, docs: HTTP });
    expect(JSON.stringify(session)).not.toContain('Bearer literal');
    expect(session).not.toHaveProperty('mcpServers');
  });

  it('keys each server label by the one server key rule', async () => {
    const env = await startService();
    const session = await env.createSession({ mcpServers: { 'Sequential Thinking': STDIO, docs: HTTP } });
    expect(env.store.getSession(session.id)?.mcpServers).toEqual({ 'sequential-thinking': STDIO, docs: HTTP });
  });

  it('rejects servers that do not validate with 400 and creates no session', async () => {
    const env = await startService();

    expectError(await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {}, mcpServers: { editor: { nonsense: true } } } }), 400, 'invalid_request');
    expectError(await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {}, mcpServers: { '@/.': STDIO } } }), 400, 'invalid_request');
    expectError(await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {}, mcpServers: { editor: { type: 'sse', url: 'https://example.com/sse' } } } }), 400, 'invalid_request');
    expect((await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {}, mcpServers: { '@/.': STDIO } } })).json.error.message).toContain('"@/."');
    expect((await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {}, mcpServers: { editor: { nonsense: true } } } })).json.error.message).toContain('"editor"');
    expect(env.store.listSessions({ limit: 100, cursor: null }).sessions).toEqual([]);
  });

  it('replaces the servers with PATCH, alone or together with the mode', async () => {
    const env = await startService();
    const session = await env.createSession({ mcpServers: { editor: STDIO } });

    const replaced = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { mcpServers: { docs: HTTP } } });
    expect(replaced.status).toBe(200);
    expect(replaced.json.session).toEqual(session);
    expect(env.store.getSession(session.id)?.mcpServers).toEqual({ docs: HTTP });

    const both = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { permissionMode: 'plan', mcpServers: {} } });
    expect(both.json.session.permissionMode).toBe('plan');
    expect(env.store.getSession(session.id)).toMatchObject({ permissionMode: 'plan', mcpServers: {} });
  });

  it('refuses a PATCH whose servers do not validate without changing the mode or the servers', async () => {
    const env = await startService();
    const session = await env.createSession({ mcpServers: { editor: STDIO } });

    expectError(await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { permissionMode: 'plan', mcpServers: { editor: { nonsense: true } } } }), 400, 'invalid_request');
    expect(env.store.getSession(session.id)).toMatchObject({ permissionMode: 'manual', mcpServers: { editor: STDIO } });
    expectError(await env.http('PATCH', '/v1/sessions/ses_missing', { body: { mcpServers: {} } }), 404, 'not_found');
  });
});
