import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { autoFitDirectoryOf } from '@momonga/config';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { MODEL_ID, OTHER_MODEL_ID, startService } from './helpers.ts';

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

const notMeasuredOf = (model: string) => ({ model, key: { classifier: `fake|${model}`, codeDigest: 'fake-code-digest', datasetDigest: 'fake-dataset-digest' }, measurement: 'not_measured' });

describe('the classifier the session view in auto names is the one that judges that session', () => {
  it('names the model of the session, with the key of that model, when no classifier is configured', async () => {
    const env = await startService();
    const created = await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {}, permissionMode: 'auto', model: OTHER_MODEL_ID } });
    expect(created.status).toBe(201);
    expect(created.json.session.autoClassifier).toEqual(notMeasuredOf(OTHER_MODEL_ID));
    const read = await env.http('GET', `/v1/sessions/${created.json.session.id}`);
    expect(read.json.session.autoClassifier).toEqual(notMeasuredOf(OTHER_MODEL_ID));
  });

  it('names the model of the session when a session changes to auto with no classifier configured', async () => {
    const env = await startService();
    const session = await env.createSession();
    const patched = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { permissionMode: 'auto' } });
    expect(patched.status).toBe(200);
    expect(patched.json.session.autoClassifier).toEqual(notMeasuredOf(MODEL_ID));
  });

  it('names the new model after the model of an auto session is switched with no classifier configured', async () => {
    const env = await startService();
    const created = await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {}, permissionMode: 'auto' } });
    expect(created.status).toBe(201);
    const switched = await env.http('PATCH', `/v1/sessions/${created.json.session.id}`, { body: { model: OTHER_MODEL_ID } });
    expect(switched.status).toBe(200);
    const read = await env.http('GET', `/v1/sessions/${created.json.session.id}`);
    expect(read.json.session.autoClassifier).toEqual(notMeasuredOf(OTHER_MODEL_ID));
  });

  it('carries no autoClassifier when the key of the session model cannot be computed and no classifier is configured', async () => {
    const env = await startService();
    env.ports.unkeyedModels.add(OTHER_MODEL_ID);
    const created = await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {}, permissionMode: 'auto', model: OTHER_MODEL_ID } });
    expect(created.status).toBe(201);
    expect(created.json.session.permissionMode).toBe('auto');
    expect(created.json.session).not.toHaveProperty('autoClassifier');
  });

  it('names the configured classifier, not the model of the session, when one is configured', async () => {
    const env = await startService();
    env.ports.settingsByCwd.set(env.layout.projectReal, { autoModeClassifier: OTHER_MODEL_ID });
    const created = await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {}, permissionMode: 'auto', model: MODEL_ID } });
    expect(created.status).toBe(201);
    expect(created.json.session.autoClassifier).toEqual(notMeasuredOf(OTHER_MODEL_ID));
  });
});

describe('a damaged measurement record of the classifier', () => {
  const KEY = { classifier: `fake|${OTHER_MODEL_ID}`, codeDigest: 'fake-code-digest', datasetDigest: 'fake-dataset-digest' };

  const damageRecord = (home: string): string => {
    const directory = autoFitDirectoryOf(home);
    const file = path.join(directory, `${sha256Hex(canonicalJson(KEY))}.json`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file, '{"key":1}');
    return file;
  };

  const expectUnreadable = (view: unknown, file: string): void => {
    expect(view).toEqual({ model: OTHER_MODEL_ID, key: KEY, measurement: 'unreadable', refusal: { file, reason: `${file}: not an auto mode measurement record` } });
  };

  it('leaves the session created, read and changed, and names the file and the reason in its classifier view', async () => {
    const env = await startService();
    env.ports.settingsByCwd.set(env.layout.projectReal, { autoModeClassifier: OTHER_MODEL_ID });
    const file = damageRecord(env.layout.home);

    const created = await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {}, permissionMode: 'auto' } });
    expect(created.status).toBe(201);
    expectUnreadable(created.json.session.autoClassifier, file);

    const read = await env.http('GET', `/v1/sessions/${created.json.session.id}`);
    expect(read.status).toBe(200);
    expectUnreadable(read.json.session.autoClassifier, file);

    const other = await env.createSession();
    const patched = await env.http('PATCH', `/v1/sessions/${other.id}`, { body: { permissionMode: 'auto' } });
    expect(patched.status).toBe(200);
    expectUnreadable(patched.json.session.autoClassifier, file);
    expect(env.errors).toEqual([]);
  });
});
