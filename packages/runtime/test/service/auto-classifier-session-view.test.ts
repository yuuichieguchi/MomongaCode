import { describe, expect, it } from 'vitest';
import { OTHER_ALIAS, startService } from './helpers.ts';

describe('the session view in auto carries the classifier measurement as information', () => {
  it('carries autoClassifier on create in auto, and none in another mode', async () => {
    const env = await startService();
    env.ports.settingsByCwd.set(env.layout.projectReal, { autoModeClassifier: OTHER_ALIAS });
    const created = await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {}, permissionMode: 'auto' } });
    expect(created.status).toBe(201);
    expect(created.json.session.autoClassifier).toMatchObject({ alias: OTHER_ALIAS, measurement: 'not_measured' });
    expect(String(created.json.session.autoClassifier.detail)).toContain('auto-mode check');
    const other = await env.createSession();
    expect((other as Record<string, unknown>)['autoClassifier']).toBeUndefined();
  });

  it('carries autoClassifier when a session changes to auto and when it is read', async () => {
    const env = await startService();
    env.ports.settingsByCwd.set(env.layout.projectReal, { autoModeClassifier: OTHER_ALIAS });
    const session = await env.createSession();
    const patched = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { permissionMode: 'auto' } });
    expect(patched.status).toBe(200);
    expect(patched.json.session.autoClassifier).toMatchObject({ alias: OTHER_ALIAS, measurement: 'not_measured' });
    const read = await env.http('GET', `/v1/sessions/${session.id}`);
    expect(read.json.session.autoClassifier).toMatchObject({ alias: OTHER_ALIAS, measurement: 'not_measured' });
  });
});
