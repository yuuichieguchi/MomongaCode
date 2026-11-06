import { describe, expect, it } from 'vitest';
import { ConfigError } from '@momonga/config';
import { OTHER_ALIAS, startService } from './helpers.ts';

describe('the session view and the session patch start no new work, so a broken settings file never refuses them (SettingsHealth View)', () => {
  it('GET /v1/sessions/:id of an auto session answers 200 with its classifier while admission is refused', async () => {
    const env = await startService();
    env.ports.settingsByCwd.set(env.layout.projectReal, { autoModeClassifier: OTHER_ALIAS });
    const created = await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {}, permissionMode: 'auto' } });
    expect(created.status).toBe(201);

    env.ports.settingsFailure.error = new ConfigError('/broken/settings.json: invalid JSON at line 1 column 2');

    const read = await env.http('GET', `/v1/sessions/${created.json.session.id}`);
    expect(read.status).toBe(200);
    expect(read.json.session.autoClassifier).toMatchObject({ alias: OTHER_ALIAS });
  });

  it('PATCH /v1/sessions/:id with a permission mode answers 200 while admission is refused', async () => {
    const env = await startService();
    env.ports.settingsByCwd.set(env.layout.projectReal, { autoModeClassifier: OTHER_ALIAS });
    const session = await env.createSession();

    env.ports.settingsFailure.error = new ConfigError('/broken/settings.json: invalid JSON at line 1 column 2');

    const patched = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { permissionMode: 'auto' } });
    expect(patched.status).toBe(200);
    expect(patched.json.session.autoClassifier).toMatchObject({ alias: OTHER_ALIAS });
  });
});
