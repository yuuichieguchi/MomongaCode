import { describe, expect, it } from 'vitest';
import { messageOf } from '@momonga/protocol';
import type { ModelViews } from '@momonga/protocol';
import { startService } from './helpers.ts';

const DEVSTRAL = 'ollama/devstral-small-2:latest';
const QWEN = 'ollama/qwen3.8:27b';
const OLLAMA_GEMMA = 'ollama/gemma-3-4b:latest';
const LMSTUDIO_GEMMA = 'lmstudio/gemma-3-4b';

const S1: ModelViews = [
  { canon: DEVSTRAL, provider: 'ollama', ownName: 'devstral-small-2:latest', defaultTag: 'latest', naming: 'server' },
  { canon: QWEN, provider: 'ollama', ownName: 'qwen3.8:27b', defaultTag: 'latest', naming: 'server' },
];

const S2: ModelViews = [
  { canon: OLLAMA_GEMMA, provider: 'ollama', ownName: 'gemma-3-4b:latest', defaultTag: 'latest', naming: 'server' },
  { canon: LMSTUDIO_GEMMA, provider: 'lmstudio', ownName: 'gemma-3-4b', naming: 'server' },
];

const serviceListing = async (views: ModelViews, start?: string) => {
  const env = await startService();
  env.ports.shown.views = views;
  if (start !== undefined) env.ports.start.model = start;
  return env;
};

const createWith = (env: Awaited<ReturnType<typeof startService>>, body: Record<string, unknown> = {}) =>
  env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {}, ...body } });

describe('the model of a session (design-model-names 3.1, 2.2, 12.1 N2.4)', () => {
  it('stores the start model of the listing when the request names no model', async () => {
    const env = await serviceListing(S1, QWEN);
    const created = await createWith(env);
    expect(created.status).toBe(201);
    expect(created.json.session.model).toBe(QWEN);
    expect(env.store.getSession(created.json.session.id)?.model).toBe(QWEN);
  });

  it('stores the full reference of the model a short name resolves to', async () => {
    const env = await serviceListing(S1);
    const created = await createWith(env, { model: 'devstral-small-2' });
    expect(created.status).toBe(201);
    expect(created.json.session.model).toBe(DEVSTRAL);
    expect(env.store.getSession(created.json.session.id)?.model).toBe(DEVSTRAL);
  });

  it('refuses a model that is not configured with 400 invalid_request, param model and the sentence that lists the configured models', async () => {
    const env = await serviceListing(S1);
    const created = await createWith(env, { model: 'nope' });
    expect(created.status).toBe(400);
    expect(created.json.error).toMatchObject({
      type: 'invalid_request',
      code: 'invalid_request',
      param: 'model',
      message: 'The model "nope" is not configured. Configured models: ollama/devstral-small-2, ollama/qwen3.8:27b.',
    });
    expect(env.store.listSessions({ limit: 100, cursor: null }).sessions).toEqual([]);
  });

  it('refuses a name two servers serve with the sentence that names both', async () => {
    const env = await serviceListing(S2);
    const created = await createWith(env, { model: 'gemma-3-4b' });
    expect(created.status).toBe(400);
    expect(created.json.error).toMatchObject({
      type: 'invalid_request',
      param: 'model',
      message: 'The model "gemma-3-4b" is served by two servers: ollama/gemma-3-4b, lmstudio/gemma-3-4b. Write one of them.',
    });
  });

  it('answers 409 target_not_ready with the no-model message when no model is configured, so there is no start model', async () => {
    const env = await serviceListing([]);
    const created = await createWith(env);
    expect(created.status).toBe(409);
    expect(created.json.error).toMatchObject({ type: 'conflict', code: 'target_not_ready', message: messageOf('noModelConnected', 'cli') });
  });

  it('stores the full reference on a patch and records model.changed with model and previousModel', async () => {
    const env = await serviceListing(S1);
    const session = (await createWith(env)).json.session;
    const patched = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { model: 'qwen3.8:27b' } });
    expect(patched.status).toBe(200);
    expect(patched.json.session.model).toBe(QWEN);
    expect(env.store.readModelChanges(session.id, 0)).toMatchObject([{ type: 'model.changed', model: QWEN, previousModel: DEVSTRAL }]);
    const refused = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { modelAlias: 'qwen3.8:27b' } });
    expect(refused.status).toBe(400);
  });

  it('changes the model of a session whose stored model is the name an earlier build wrote', async () => {
    const env = await serviceListing(S1);
    const session = env.store.createSession({ cwd: env.layout.projectReal, env: {}, permissionMode: 'manual', model: 'local' });
    const patched = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { model: 'devstral-small-2:latest' } });
    expect(patched.status).toBe(200);
    expect(env.store.getSession(session.id)?.model).toBe(DEVSTRAL);
    expect(env.store.readModelChanges(session.id, 0)).toMatchObject([{ model: DEVSTRAL, previousModel: 'local' }]);
  });
});
