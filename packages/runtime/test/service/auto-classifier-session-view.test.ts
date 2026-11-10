import { describe, expect, it } from 'vitest';
import { OTHER_MODEL_ID, startService } from './helpers.ts';

const expectNotMeasured = (view: Record<string, unknown> | undefined): void => {
  expect(view).toMatchObject({ model: OTHER_MODEL_ID, measurement: 'not_measured' });
  expect(Object.keys(view ?? {}).sort()).toEqual(['key', 'measurement', 'model']);
  expect(view?.['key']).toMatchObject({ classifier: expect.any(String), codeDigest: expect.any(String), datasetDigest: expect.any(String) });
};

describe('the session view in auto carries the classifier measurement as information', () => {
  it('carries autoClassifier on create in auto, and none in another mode', async () => {
    const env = await startService();
    env.ports.settingsByCwd.set(env.layout.projectReal, { autoModeClassifier: OTHER_MODEL_ID });
    const created = await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {}, permissionMode: 'auto' } });
    expect(created.status).toBe(201);
    expectNotMeasured(created.json.session.autoClassifier);
    const other = await env.createSession();
    expect((other as Record<string, unknown>)['autoClassifier']).toBeUndefined();
  });

  it('carries autoClassifier when a session changes to auto and when it is read', async () => {
    const env = await startService();
    env.ports.settingsByCwd.set(env.layout.projectReal, { autoModeClassifier: OTHER_MODEL_ID });
    const session = await env.createSession();
    const patched = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { permissionMode: 'auto' } });
    expect(patched.status).toBe(200);
    expectNotMeasured(patched.json.session.autoClassifier);
    const read = await env.http('GET', `/v1/sessions/${session.id}`);
    expectNotMeasured(read.json.session.autoClassifier);
  });
});
