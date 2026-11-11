import { describe, expect, it } from 'vitest';
import { NEVER_CANCELLED } from '@momonga/testkit';
import { startService } from './helpers.ts';
import type { JsonResponse, ServiceEnv } from './helpers.ts';

const SESSION_ENV = { PATH: '/usr/bin:/bin', LANG: 'C' };

const create = (env: ServiceEnv, body: Record<string, unknown>): Promise<JsonResponse> =>
  env.http('POST', '/v1/sessions', { body: { env: SESSION_ENV, cwd: env.layout.project, ...body } });

describe('session create in a folder without a terminal UI', () => {
  it('an undecided folder created without a terminal UI answers one notice that names momonga trust', async () => {
    const env = await startService({ fakeTimers: true });
    const response = await create(env, { terminalUi: false });
    expect(response.status).toBe(201);
    expect(response.json.trustNotice).toBe(
      `the folder ${env.layout.projectReal} is not decided, so its own settings and everything they could make the product run are not loaded; decide it with momonga trust ${env.layout.projectReal}`,
    );
  });

  it('a decided folder answers no notice', async () => {
    const env = await startService({ fakeTimers: true });
    await env.store.trust.setAsked(env.layout.project, 'trusted', NEVER_CANCELLED);
    const trusted = await create(env, { terminalUi: false });
    expect(trusted.status).toBe(201);
    expect(trusted.json).not.toHaveProperty('trustNotice');
    await env.store.trust.setAsked(env.layout.project, 'untrusted', NEVER_CANCELLED);
    const untrusted = await create(env, { terminalUi: false });
    expect(untrusted.status).toBe(201);
    expect(untrusted.json).not.toHaveProperty('trustNotice');
  });

  it('a client with a terminal UI answers no notice, because it asks the person first', async () => {
    const env = await startService({ fakeTimers: true });
    const response = await create(env, { terminalUi: true });
    expect(response.status).toBe(201);
    expect(response.json).not.toHaveProperty('trustNotice');
  });

  it('the trust state of the folder is readable by GET /v1/trust', async () => {
    const env = await startService({ fakeTimers: true });
    const response = await env.http('GET', `/v1/trust?path=${encodeURIComponent(env.layout.project)}`);
    expect(response.json.trust).toEqual({ path: env.layout.projectReal, decision: null });
  });
});
